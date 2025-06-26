/**
 * index.js for 'createOrUpdatePipeline'
 *
 * This secure function allows a tenant admin to save a pipeline configuration,
 * which defines the source columns to be used for AI analysis.
 * gcloud functions deploy createOrUpdatePipeline --gen2 --runtime=nodejs22 --trigger-http --allow-unauthenticated
 */
const functions = require('@google-cloud/functions-framework');
const admin = require('firebase-admin');

admin.initializeApp();
const auth = admin.auth();
const db = admin.firestore();

functions.http('createOrUpdatePipeline', async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(204).send('');
    
    const idToken = req.headers.authorization?.split('Bearer ')[1];
    if (!idToken) return res.status(401).send({ error: 'Unauthorized' });
    
    let decodedToken;
    try {
        decodedToken = await auth.verifyIdToken(idToken);
    } catch (error) {
        return res.status(401).send({ error: 'Invalid token.' });
    }

    if (decodedToken.role !== 'admin') {
        return res.status(403).send({ error: 'Forbidden: Only admins can manage pipelines.' });
    }

    const { pipelineName, configuration } = req.body;
    if (!pipelineName || !configuration || !configuration.sourceColumnsForAI || !configuration.classificationTargets) {
        return res.status(400).send({ error: 'Missing required fields in the configuration object.' });
    }
    
    const tenantId = decodedToken.tenantId;

    try {
        const pipelineRef = db.collection('tenants').doc(tenantId).collection('pipelines').doc(pipelineName);
        
        await pipelineRef.set({
            configuration,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

        res.status(200).send({ message: `Pipeline '${pipelineName}' saved successfully.` });

    } catch (error) {
        console.error("Error saving pipeline:", error);
        res.status(500).send({ error: 'An internal error occurred.' });
    }
});
