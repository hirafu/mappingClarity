/**
 * index.js for 'processCSV' (Multi-Tenant)
 *
 * This version now counts the total rows from the uploaded CSV and saves
 * that count to the main job document in Firestore.
 */

const functions = require('@google-cloud/functions-framework');
const { Storage } = require('@google-cloud/storage');
const csv = require('csv-parser');
const { GoogleGenAI } = require('@google/genai');
const { Firestore, FieldValue } = require('@google-cloud/firestore');

// --- Configuration ---
const PROJECT_ID = 'project-clarity-463800';
const LOCATION = 'us-central1';
const AI_MODEL = 'gemini-2.5-flash'; // Using a stable, available model

// Firestore paths
const definitionsCollection = 'definitions';
const definitionsDocument = 'hierarchical';
const tenantsCollection = 'tenants';

// --- Client Initialization ---
const storage = new Storage();
const firestore = new Firestore();
const genAI = new GoogleGenAI({
    vertexai: true,
    project: PROJECT_ID,
    location: LOCATION,
});


// --- Caching for Definitions ---
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


function createPrompt(row, structuredDefs) {
    let definitionsText = 'Here is the hierarchy of valid cost pools and their sub-pools:\n';
    for (const poolName in structuredDefs) {
        const poolData = structuredDefs[poolName];
        definitionsText += `\nCost Pool: "${poolName}" (Definition: ${poolData.definition})\n`;
        definitionsText += `For this Cost Pool, the only valid Cost Sub-Pools are:\n`;
        poolData.sub_pools.forEach(subPool => {
            definitionsText += `- "${subPool.name}": which means "${subPool.definition}"\n`;
        });
    }
    const rowText = JSON.stringify(row);
    return `
    You are an expert financial analyst. Your task is to assign a cost pool and a cost sub-pool to a transaction based on a strict hierarchy and provided definitions.
    ${definitionsText}
    First, analyze the following transaction data to determine the correct Cost Pool based on its definition.
    Transaction Data: ${rowText}
    After determining the Cost Pool, select the most appropriate Cost Sub-Pool from its list of valid options, based on the sub-pool's definition.
    Respond with only a valid JSON object in the format {"cost_pool": "...", "cost_sub_pool": "...", "confidence": 0.xx, "reasoning": "..."} and nothing else.
  `;
}

/**
 * Main Cloud Function logic
 */
functions.cloudEvent('processCSV', async (cloudEvent, context) => {
    try {
        const structuredDefs = await getStructuredDefinitions();
        if (!structuredDefs || Object.keys(structuredDefs).length === 0) {
            return;
        }

        const fileData = cloudEvent.data;
        if (!fileData || !fileData.name || !fileData.bucket) {
            console.log("Invalid event data. Exiting.");
            return;
        }

        const filePath = fileData.name;
        // The path now looks like: `uploads/{tenantId}/{jobId}/{filename}`
        const pathParts = filePath.split('/');
        if (pathParts.length < 4 || pathParts[0] !== 'uploads') {
            console.log(`File ${filePath} is not in a valid tenant/job directory, skipping.`);
            return;
        }

        const tenantId = pathParts[1];
        const jobId = pathParts[2];
        const originalFilename = pathParts[3];
        console.log(`Processing file: ${originalFilename} for Tenant ID: ${tenantId}, Job ID: ${jobId}`);

        // Create the main job document within the correct tenant's subcollection
        const jobDocRef = firestore.collection(tenantsCollection).doc(tenantId).collection('jobs').doc(jobId);
        await jobDocRef.set({
            id: jobId,
            originalFilename: originalFilename,
            createdAt: FieldValue.serverTimestamp(),
            status: 'reading' // Initial status
        });

        const sourceFile = storage.bucket(fileData.bucket).file(filePath);
        const records = [];
        await new Promise((resolve, reject) => {
            sourceFile.createReadStream()
                .pipe(csv({ bom: true, mapHeaders: ({ header }) => header.trim() }))
                .on('data', (data) => records.push(data))
                .on('error', reject)
                .on('end', resolve);
        });

        // **NEW**: Update the job document with the total row count
        await jobDocRef.update({
            totalRows: records.length,
            status: 'processing'
        });
        console.log(`Finished reading ${records.length} rows from source file.`);

        const classificationPromises = records.map(async (row, index) => {
            const prompt = createPrompt(row, structuredDefs);
            const result = await genAI.models.generateContent({ model: AI_MODEL, contents: prompt });
            
            let classification = {
                cost_pool: 'Unclassified',
                cost_sub_pool: 'Unclassified',
                confidence: 0.0,
                reasoning: 'AI response could not be parsed or validated.'
            };

            try {
                const jsonText = result.text.trim().replace(/```json|```/g, '');
                const suggestion = JSON.parse(jsonText);
                
                if (suggestion.cost_pool && structuredDefs[suggestion.cost_pool]) {
                    const isValidSubpool = structuredDefs[suggestion.cost_pool].sub_pools.some(
                        (sp) => sp.name === suggestion.cost_sub_pool
                    );
                    if (isValidSubpool) {
                        classification = {
                            cost_pool: suggestion.cost_pool,
                            cost_sub_pool: suggestion.cost_sub_pool,
                            confidence: suggestion.confidence || 0.0,
                            reasoning: suggestion.reasoning || 'No reasoning provided.'
                        };
                    }
                }
            } catch (e) {
                console.error(`Failed to process row ${index}. Response text: "${result.text}"`, e);
            }

            // Write results to a subcollection within the specific job document
            const rowDocRef = jobDocRef.collection('rows').doc(String(index));
            await rowDocRef.set({
                original_data: row,
                ...classification,
                row_index: index,
                confidence: Number(classification.confidence) || 0.0
            });
        });

        await Promise.all(classificationPromises);
        
        await jobDocRef.update({ status: 'completed' });
        console.log(`Finished processing and writing to Firestore for Job ID: ${jobId}`);

    } catch (err) {
        console.error("An unhandled error occurred:", err);
    }
});
