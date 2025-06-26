/**
 * index.js for the 'createTenant' HTTP Cloud Function
 *
 * This version integrates with SendGrid to send a real invitation email
 * to the new tenant admin after their account is created.
 */

const functions = require('@google-cloud/functions-framework');
const admin = require('firebase-admin');
const sgMail = require('@sendgrid/mail');

// Initialize Firebase Admin SDK
admin.initializeApp();
const auth = admin.auth();
const db = admin.firestore();

// --- SENDGRID CONFIGURATION ---
// Set the SendGrid API Key from a secure environment variable
sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const FROM_EMAIL = 'no-reply@mappingclarity.com'; // The "from" email address

/**
 * A secure, authenticated HTTP function.
 */
functions.http('createTenant', async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(204).send('');
    }
    
    const idToken = req.headers.authorization?.split('Bearer ')[1];
    if (!idToken) {
        return res.status(401).send({ error: 'Unauthorized: No token provided.' });
    }

    let decodedToken;
    try {
        decodedToken = await auth.verifyIdToken(idToken);
    } catch (error) {
        return res.status(401).send({ error: 'Unauthorized: Invalid token.' });
    }

    if (decodedToken.superAdmin !== true) {
        return res.status(403).send({ error: 'Forbidden: Caller is not a super admin.' });
    }

    const { tenantName, adminEmail } = req.body;
    if (!tenantName || !adminEmail) {
        return res.status(400).send({ error: 'Missing tenantName or adminEmail.' });
    }

    try {
        const tenantRef = await db.collection('tenants').add({
            name: tenantName,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        const tenantId = tenantRef.id;

        const userRecord = await auth.createUser({
            email: adminEmail,
            emailVerified: false,
            displayName: `${tenantName} Admin`,
        });

        await auth.setCustomUserClaims(userRecord.uid, {
            tenantId: tenantId,
            role: 'admin',
            superAdmin: false,
        });
        
        const link = await auth.generatePasswordResetLink(adminEmail);
        
        // **NEW**: Send the invitation email using SendGrid
        const msg = {
          to: adminEmail,
          from: FROM_EMAIL,
          subject: 'You have been invited to Project Clarity',
          html: `
            <h1>Welcome to Project Clarity!</h1>
            <p>You have been invited to be the administrator for the tenant: <strong>${tenantName}</strong>.</p>
            <p>Please click the link below to set up your account and create a password:</p>
            <p><a href="${link}">Set Your Password</a></p>
            <p>This link will expire in 24 hours.</p>
          `,
        };

        await sgMail.send(msg);
        console.log(`Invitation email sent successfully to ${adminEmail}`);

        res.status(200).send({
            message: 'Tenant and admin created successfully. Invitation sent.',
            tenantId: tenantId,
            tenantName: tenantName,
            adminEmail: adminEmail
        });

    } catch (error) {
        console.error("Error in createTenant function:", error);
        res.status(500).send({ error: 'An internal error occurred.', details: error.message });
    }
});
