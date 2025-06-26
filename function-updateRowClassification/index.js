/**
 * index.js for the 'updateRowClassification' HTTP Cloud Function
 *
 * This version now accepts both a new cost pool and sub-pool in a
 * single request, validates the changes, and creates detailed audit
 * trail records for each field that was modified.
 */

const functions = require('@google-cloud/functions-framework');
const admin = require('firebase-admin');

// Initialize Firebase Admin SDK
admin.initializeApp();
const auth = admin.auth();
const db = admin.firestore();

functions.http('updateRowClassification', async (req, res) => {
    // Set CORS headers for browser access
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(204).send('');
    }

    // --- Authentication & Authorization ---
    const idToken = req.headers.authorization?.split('Bearer ')[1];
    if (!idToken) {
        return res.status(401).send({ error: 'Unauthorized' });
    }

    let decodedToken;
    try {
        decodedToken = await auth.verifyIdToken(idToken);
    } catch (error) {
        return res.status(401).send({ error: 'Invalid token.' });
    }

    const { tenantId, role, email } = decodedToken;
    if (!tenantId || (role !== 'admin' && role !== 'uploader')) {
        return res.status(403).send({ error: 'Forbidden: User does not have permission to update records.' });
    }

    // --- Main Logic ---
    // **MODIFIED**: Now expects newCostPool and newCostSubPool
    const { jobId, rowId, newCostPool, newCostSubPool } = req.body;
    if (!jobId || !rowId || newCostPool === undefined || newCostSubPool === undefined) {
        return res.status(400).send({ error: 'Missing required fields: jobId, rowId, newCostPool, newCostSubPool.' });
    }

    const rowDocRef = db.collection('tenants').doc(tenantId).collection('jobs').doc(jobId).collection('rows').doc(rowId);
    const auditTrailRef = rowDocRef.collection('audit_trail');

    try {
        await db.runTransaction(async (transaction) => {
            const rowDoc = await transaction.get(rowDocRef);
            if (!rowDoc.exists) {
                throw new Error("Row document not found.");
            }
            
            const oldData = rowDoc.data();
            const updates = {};
            const auditEvents = [];

            // Check if cost_pool has changed
            if (oldData.cost_pool !== newCostPool) {
                updates.cost_pool = newCostPool;
                auditEvents.push({
                    field: 'cost_pool',
                    oldValue: oldData.cost_pool,
                    newValue: newCostPool,
                });
            }

            // Check if cost_sub_pool has changed
            if (oldData.cost_sub_pool !== newCostSubPool) {
                updates.cost_sub_pool = newCostSubPool;
                 auditEvents.push({
                    field: 'cost_sub_pool',
                    oldValue: oldData.cost_sub_pool,
                    newValue: newCostSubPool,
                });
            }

            // If there are any changes, update the document and create audit records
            if (Object.keys(updates).length > 0) {
                updates.manually_edited = true; // Flag that this row has been changed
                transaction.update(rowDocRef, updates);

                const timestamp = admin.firestore.FieldValue.serverTimestamp();
                for (const event of auditEvents) {
                     transaction.set(auditTrailRef.doc(), {
                        changedBy: email,
                        timestamp: timestamp,
                        ...event
                    });
                }
            }
        });

        res.status(200).send({ message: 'Update successful.' });

    } catch (error) {
        console.error(`Error updating row ${rowId} for job ${jobId}:`, error);
        res.status(500).send({ error: 'An internal error occurred.', details: error.message });
    }
});
