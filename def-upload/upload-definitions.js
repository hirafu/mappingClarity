/**
 * upload-definitions.js
 *
 * A one-time script to read your hierarchical CSV definitions and upload
 * them into a single document in your Firestore database.
 *
 * HOW TO RUN:
 * 1. Place this file in a new, empty folder on your computer.
 * 2. Place your `cost_definitions_hierarchical.csv` file in the same folder.
 * 3. Download your Firebase service account key JSON and save it as `serviceAccountKey.json` in the same folder.
 * (In Google Cloud Console, go to IAM & Admin -> Service Accounts -> Find the App Engine default service account -> Actions (three dots) -> Manage keys -> Add Key -> Create new key -> JSON)
 * 4. Run `npm install` in your terminal inside this folder.
 * 5. Run `node upload-definitions.js` in your terminal.
 */

const admin = require('firebase-admin');
const fs = require('fs');
const csv = require('csv-parser');

// --- CONFIGURATION ---
const SERVICE_ACCOUNT_KEY_PATH = './serviceAccountKey.json';
const DEFINITIONS_CSV_PATH = './cost_definitions_hierarchical.csv';
const FIRESTORE_COLLECTION = 'definitions';
const FIRESTORE_DOCUMENT = 'hierarchical';

// --- INITIALIZE FIREBASE ADMIN ---
try {
    const serviceAccount = require(SERVICE_ACCOUNT_KEY_PATH);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
} catch (e) {
    console.error('🔥 FATAL ERROR: Could not find or parse `serviceAccountKey.json`.');
    console.error('Please download it from your GCP project\'s IAM & Admin -> Service Accounts section.');
    process.exit(1);
}


const db = admin.firestore();
console.log('Firebase Admin initialized.');

/**
 * Main function to read, parse, structure, and upload the definitions.
 */
async function processAndUpload() {
  console.log(`Reading definitions from ${DEFINITIONS_CSV_PATH}...`);
  const structuredDefs = {};

  fs.createReadStream(DEFINITIONS_CSV_PATH)
    .pipe(csv({ bom: true, mapHeaders: ({ header }) => header.trim() }))
    .on('data', (row) => {
      const { cost_pool, cost_pool_definition, cost_sub_pool, cost_sub_pool_definition } = row;
      if (!cost_pool || !cost_sub_pool) return;

      if (!structuredDefs[cost_pool]) {
        structuredDefs[cost_pool] = {
          definition: cost_pool_definition,
          sub_pools: [],
        };
      }
      structuredDefs[cost_pool].sub_pools.push({ name: cost_sub_pool, definition: cost_sub_pool_definition });
    })
    .on('end', async () => {
      console.log(`Finished parsing. Found ${Object.keys(structuredDefs).length} cost pools.`);
      
      if (Object.keys(structuredDefs).length === 0) {
        console.error("No definitions were structured. Please check the CSV file. Aborting upload.");
        return;
      }

      try {
        console.log(`Uploading to Firestore collection '${FIRESTORE_COLLECTION}', document '${FIRESTORE_DOCUMENT}'...`);
        const docRef = db.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOCUMENT);
        
        // We store the entire structured object in a field called 'data'
        await docRef.set({ data: structuredDefs });
        
        console.log('---');
        console.log('✅ Success! Definitions have been uploaded to Firestore.');
        console.log('---');
        process.exit(0);
      } catch (error) {
        console.error('🔥 Error uploading to Firestore:', error);
        process.exit(1);
      }
    });
}

processAndUpload();
