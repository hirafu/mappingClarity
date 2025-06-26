/**
 * index.js for the 'uploadFile' HTTP Cloud Function (Multi-Tenant)
 *
 * This secure function handles file uploads from authenticated users.
 * It verifies the user's role and uses their tenantId to place the file
 * in the correct isolated path, which then triggers the 'processCSV' function.
 */
const { Storage } = require('@google-cloud/storage');
const Busboy = require('busboy');
const path = require('path');
const os = require('os');
const fs = require('fs');
const admin = require('firebase-admin');

// Initialize clients
admin.initializeApp();
const auth = admin.auth();
const storage = new Storage();
const bucket = storage.bucket('clarity-data'); // Your target bucket

exports.uploadFile = (req, res) => {
    // Set CORS headers for browser access
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(204).send('');
    }

    if (req.method !== 'POST') {
        return res.status(405).send({ error: 'Method Not Allowed' });
    }

    // Wrap main logic in a promise to handle async operations
    return new Promise(async (resolve, reject) => {
        // --- Authentication and Authorization ---
        const idToken = req.headers.authorization?.split('Bearer ')[1];
        if (!idToken) {
            res.status(401).send({ error: 'Unauthorized: No token provided.' });
            return reject(new Error('No token provided.'));
        }

        let decodedToken;
        try {
            decodedToken = await auth.verifyIdToken(idToken);
        } catch (error) {
            return reject(res.status(401).send({ error: 'Invalid token.' }));
        }

        const { tenantId, role } = decodedToken;
        if (!tenantId || (role !== 'admin' && role !== 'uploader')) {
            return reject(res.status(403).send({ error: 'Forbidden' }));
        }

        // --- File Handling ---
        const jobId = req.query.jobId;
        const pipelineId = req.query.pipelineId; // **NEW**
        if (!jobId || !pipelineId) {
            return reject(res.status(400).send({ error: 'A jobId and pipelineId are required.' }));
        }

        const busboy = Busboy({ headers: req.headers });
        const tmpdir = os.tmpdir();
        const fileWrites = [];
        let uploadedFile = null;

        busboy.on('file', (fieldname, file, { filename, mimeType }) => {
            const filepath = path.join(tmpdir, filename);
            uploadedFile = { filepath, originalFilename: filename, mimeType };
            const writeStream = fs.createWriteStream(filepath);
            file.pipe(writeStream);
            const promise = new Promise((resolve, reject) => {
                file.on('end', () => writeStream.end());
                writeStream.on('finish', resolve);
                writeStream.on('error', reject);
            });
            fileWrites.push(promise);
        });

        busboy.on('finish', async () => {
            await Promise.all(fileWrites);

            if (!uploadedFile) {
                res.status(400).json({ error: 'No file uploaded.' });
                return reject(new Error('No file uploaded.'));
            }

            const { filepath, originalFilename } = uploadedFile;
            // Construct the isolated, tenant-specific destination path
            const gcsPath = `uploads/${tenantId}/${pipelineId}/${jobId}/${originalFilename}`;

            try {
                await bucket.upload(filepath, { destination: gcsPath });
                fs.unlinkSync(filepath);

                res.status(200).json({ jobId, pipelineId });
                resolve();
            } catch (error) {
                console.error(`Error uploading to GCS for job ${jobId}:`, error);
                reject(error);
            }
        });

        busboy.on('error', (err) => {
            console.error('Busboy error:', err);
            reject(err);
        });

        if (req.rawBody) {
            busboy.end(req.rawBody);
        } else {
            req.pipe(busboy);
        }
    }).catch(err => {
        // Ensure a response is sent on rejection if one hasn't been already
        if (!res.headersSent) {
            res.status(500).send({ error: 'An internal error occurred.' });
        }
    });
};
