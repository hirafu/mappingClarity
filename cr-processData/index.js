/**
 * index.js for the 'process-csv' Cloud Run Job (Complete & Ready for Deployment)
 *
 * This version is designed to be executed by a Cloud Workflow. It receives
 * the GCS bucket and file name as command-line arguments. It streams the file,
 * normalizes data based on tenant mappings, processes rows in batches with
 * Vertex AI, and bulk-writes the results to Firestore.
 */

const { Storage } = require('@google-cloud/storage');
const csv = require('csv-parser');
const { GoogleGenAI } = require('@google/genai');
const { Firestore } = require('@google-cloud/firestore');

// --- CONFIGURATION ---
const BATCH_SIZE = 50; // Process 50 rows in a single AI call
const PROJECT_ID = process.env.GCLOUD_PROJECT || 'project-clarity-463800';
const LOCATION = 'us-central1';
const AI_MODEL = 'gemini-2.5-flash';

// Firestore paths
const definitionsCollection = 'definitions';
const definitionsDocument = 'hierarchical';
const tenantsCollection = 'tenants';

// --- CLIENT INITIALIZATION ---
const storage = new Storage();
const firestore = new Firestore();
const genAI = new GoogleGenAI({ vertexai: true, project: PROJECT_ID, location: LOCATION });

// --- HELPER FUNCTIONS ---

let definitionsCache = null;
async function getStructuredDefinitions() {
    if (definitionsCache) {
        return definitionsCache;
    }
    console.log(`Fetching definitions from Firestore: ${definitionsCollection}/${definitionsDocument}`);
    const docRef = firestore.collection(definitionsCollection).doc(definitionsDocument);
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
        throw new Error("Definitions document not found. Please run the upload-definitions.js script.");
    }
    definitionsCache = docSnap.data().data;
    console.log(`Loaded definitions for ${Object.keys(definitionsCache).length} cost pools.`);
    return definitionsCache;
}

function createBatchPrompt(rows, structuredDefs) {
    const rowTexts = rows.map((row, index) => 
        `"transaction_${row.index}": ${JSON.stringify(row.data)}`
    ).join(',\n    ');
    
    let definitionsText = 'Here is the hierarchy of valid cost pools and their sub-pools:\n';
    for (const poolName in structuredDefs) {
        const poolData = structuredDefs[poolName];
        definitionsText += `\nCost Pool: "${poolName}" (Definition: ${poolData.definition})\n`;
        definitionsText += `For this Cost Pool, the only valid Cost Sub-Pools are:\n`;
        poolData.sub_pools.forEach(subPool => {
            definitionsText += `- "${subPool.name}": which means "${subPool.definition}"\n`;
        });
    }

    return `
    You are an expert financial analyst. You will be given a JSON object containing multiple financial transactions.
    For each transaction, you must assign a cost pool and sub-pool based on the strict hierarchy provided below.
    
    ${definitionsText}

    Analyze the following transactions:
    {
      ${rowTexts}
    }

    Respond with ONLY a single, valid JSON object where each key is the transaction ID (e.g., "transaction_0")
    and the value is another JSON object in the format {"cost_pool": "...", "cost_sub_pool": "...", "confidence": 0.xx, "reasoning": "..."}.
    `;
}

async function processBatch(batch, structuredDefs, tenantId, jobId, bulkWriter) {
    console.log(`Processing batch of ${batch.length} rows starting with index ${batch[0].index}...`);
    const prompt = createBatchPrompt(batch, structuredDefs);
    
    let aiResponse;
    try {
        const result = await genAI.models.generateContent({ model: AI_MODEL, contents: prompt });
        const jsonText = result.text.trim().replace(/```json|```/g, '');
        aiResponse = JSON.parse(jsonText);
    } catch (e) {
        console.error("Failed to call AI or parse its response for a batch:", e);
        aiResponse = {}; // Ensure aiResponse is an object to prevent crashes
    }

    for (const row of batch) {
        const result = aiResponse[`transaction_${row.index}`];
        
        let classification = {
            cost_pool: 'Unclassified',
            cost_sub_pool: 'Unclassified',
            confidence: 0.0,
            reasoning: 'AI response was missing, invalid, or could not be parsed.'
        };

        if (result) {
            if (result.cost_pool && structuredDefs[result.cost_pool]) {
                const isValidSubpool = structuredDefs[result.cost_pool].sub_pools.some(sp => sp.name === result.cost_sub_pool);
                if (isValidSubpool) {
                    classification = {
                        cost_pool: result.cost_pool,
                        cost_sub_pool: result.cost_sub_pool,
                        confidence: result.confidence || 0.0,
                        reasoning: result.reasoning || 'No reasoning provided.'
                    };
                }
            }
        }
        
        const docRef = firestore.collection(tenantsCollection).doc(tenantId).collection('jobs').doc(jobId).collection('rows').doc(String(row.index));
        bulkWriter.set(docRef, {
            original_data: row.data,
            ...classification,
            row_index: row.index,
            confidence: Number(classification.confidence) || 0.0
        });
    }
}

// --- MAIN JOB LOGIC ---
async function main() {
    console.log("Cloud Run Job started by Workflow.");

    // Read bucket and file from command-line arguments provided by the workflow
    const args = process.argv.slice(2);
    const gcsBucket = args[0];
    const gcsFile = args[1];

    if (!gcsBucket || !gcsFile) {
        throw new Error("Missing GCS bucket or file name arguments. The job must be called with [BUCKET] [FILE].");
    }
    
    const filePath = gcsFile;
    const pathParts = filePath.split('/');
    if (pathParts.length < 4 || pathParts[0] !== 'uploads') {
        throw new Error(`Invalid file path structure: ${filePath}. Expected 'uploads/{tenantId}/{jobId}/{filename}'.`);
    }

    const tenantId = pathParts[1];
    const jobId = pathParts[2];
    const originalFilename = pathParts[3];

    console.log(`Starting job for Tenant: ${tenantId}, Job: ${jobId}`);
    
    const jobDocRef = firestore.collection(tenantsCollection).doc(tenantId).collection('jobs').doc(jobId);
    
    const [structuredDefs] = await Promise.all([
        getStructuredDefinitions(),
        jobDocRef.set({
            id: jobId,
            originalFilename,
            createdAt: Firestore.FieldValue.serverTimestamp(),
            status: 'reading',
        }, { merge: true })
    ]);

    const file = storage.bucket(gcsBucket).file(gcsFile);
    const fileStream = file.createReadStream();
    const csvStream = fileStream.pipe(csv({ bom: true, mapHeaders: ({ header }) => header.trim() }));

    let batch = [];
    let rowIndex = 0;
    const bulkWriter = firestore.bulkWriter();

    for await (const row of csvStream) {
        batch.push({ index: rowIndex, data: row });
        rowIndex++;

        if (batch.length >= BATCH_SIZE) {
            await jobDocRef.update({ status: `processing_batch_${Math.floor(rowIndex / BATCH_SIZE)}` });
            await processBatch(batch, structuredDefs, tenantId, jobId, bulkWriter);
            batch = [];
        }
    }

    if (batch.length > 0) {
        await processBatch(batch, structuredDefs, tenantId, jobId, bulkWriter);
    }

    console.log("All batches processed. Finalizing job...");
    await bulkWriter.close();

    await jobDocRef.update({
        status: 'completed',
        totalRows: rowIndex
    });

    console.log("Job completed successfully.");
}

main().catch(async (err) => {
    console.error("Job failed with an unhandled error:", err);
    // In a production scenario, you would update the job status to 'failed' in Firestore.
    const args = process.argv.slice(2);
    const gcsFile = args[1]; // Get file path from args to extract IDs
    if (gcsFile) {
        const pathParts = gcsFile.split('/');
        if (pathParts.length >= 4) {
            const tenantId = pathParts[1];
            const jobId = pathParts[2];
            await firestore.collection(tenantsCollection).doc(tenantId).collection('jobs').doc(jobId).update({
                status: 'failed',
                error: err.message
            });
        }
    }
    process.exit(1);
});
