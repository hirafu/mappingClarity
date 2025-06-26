/**
 * index.js for the 'manageUser' HTTP Cloud Function
 *
 * This secure, multi-purpose function allows a tenant admin to manage users
 * within their own tenant. It handles listing, role changes, disabling,
 * and deleting users based on the 'action' parameter in the request.
 */

const functions = require('@google-cloud/functions-framework');
const admin = require('firebase-admin');

// Initialize Firebase Admin SDK
admin.initializeApp();
const auth = admin.auth();

/**
 * A secure, authenticated HTTP function for user management.
 */
functions.http('manageUser', async (req, res) => {
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

    // Security Check: Caller must be an admin of a specific tenant.
    if (decodedToken.role !== 'admin' || !decodedToken.tenantId) {
        return res.status(403).send({ error: 'Forbidden: Caller is not a tenant admin.' });
    }

    const { action, uid, newRole, disabled } = req.body;
    const adminTenantId = decodedToken.tenantId;

    try {
        // --- Action Dispatcher ---
        switch (action) {
            case 'listUsers': {
                const listUsersResult = await auth.listUsers(1000);
                // Filter users to only include those belonging to the admin's tenant
                const tenantUsers = listUsersResult.users
                    .filter(user => user.customClaims?.tenantId === adminTenantId)
                    .map(user => ({
                        uid: user.uid,
                        email: user.email,
                        role: user.customClaims?.role || 'viewer',
                        disabled: user.disabled,
                        lastSignInTime: user.metadata.lastSignInTime,
                    }));
                return res.status(200).send(tenantUsers);
            }

            case 'updateRole': {
                if (!uid || !newRole || !['uploader', 'viewer'].includes(newRole)) {
                    return res.status(400).send({ error: 'Invalid UID or role provided.' });
                }
                const userToUpdate = await auth.getUser(uid);
                if (userToUpdate.customClaims?.tenantId !== adminTenantId) {
                    return res.status(403).send({ error: 'Forbidden: Cannot manage users of another tenant.' });
                }
                await auth.setCustomUserClaims(uid, { ...userToUpdate.customClaims, role: newRole });
                return res.status(200).send({ message: `Successfully updated role for user ${userToUpdate.email} to ${newRole}.` });
            }

            case 'disableUser': {
                 if (!uid || typeof disabled !== 'boolean') {
                    return res.status(400).send({ error: 'Invalid UID or disabled status provided.' });
                }
                const userToDisable = await auth.getUser(uid);
                 if (userToDisable.customClaims?.tenantId !== adminTenantId) {
                    return res.status(403).send({ error: 'Forbidden: Cannot manage users of another tenant.' });
                }
                await auth.updateUser(uid, { disabled });
                return res.status(200).send({ message: `Successfully ${disabled ? 'disabled' : 'enabled'} user ${userToDisable.email}.` });
            }

            case 'deleteUser': {
                 if (!uid) {
                    return res.status(400).send({ error: 'Invalid UID provided.' });
                }
                const userToDelete = await auth.getUser(uid);
                 if (userToDelete.customClaims?.tenantId !== adminTenantId) {
                    return res.status(403).send({ error: 'Forbidden: Cannot manage users of another tenant.' });
                }
                await auth.deleteUser(uid);
                return res.status(200).send({ message: `Successfully deleted user.` });
            }

            default:
                return res.status(400).send({ error: 'Invalid action specified.' });
        }
    } catch (error) {
        console.error(`Error performing action '${action}':`, error);
        res.status(500).send({ error: 'An internal error occurred.', details: error.message });
    }
});
