const functions = require('@google-cloud/functions-framework');
const admin = require('firebase-admin');
const sgMail = require('@sendgrid/mail');

admin.initializeApp();
const auth = admin.auth();
sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const FROM_EMAIL = 'no-reply@mappingclarity.com';

functions.http('inviteUser', async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') { return res.status(204).send(''); }
    
    const idToken = req.headers.authorization?.split('Bearer ')[1];
    if (!idToken) { return res.status(401).send({ error: 'Unauthorized' }); }

    let decodedToken;
    try {
        decodedToken = await auth.verifyIdToken(idToken);
    } catch (error) {
        return res.status(401).send({ error: 'Invalid token.' });
    }

    // Security Check: Caller must be an admin
    if (decodedToken.role !== 'admin') {
        return res.status(403).send({ error: 'Forbidden: Only admins can invite users.' });
    }

    const { newEmail, newRole } = req.body;
    if (!newEmail || !newRole || !['uploader', 'viewer'].includes(newRole)) {
        return res.status(400).send({ error: 'Missing or invalid email/role.' });
    }

    try {
        const userRecord = await auth.createUser({
            email: newEmail,
            displayName: newEmail,
        });

        await auth.setCustomUserClaims(userRecord.uid, {
            tenantId: decodedToken.tenantId, // Assign to the admin's own tenant
            role: newRole,
        });
        
        const link = await auth.generatePasswordResetLink(newEmail);
        
        await sgMail.send({
          to: newEmail,
          from: FROM_EMAIL,
          subject: 'You have been invited to Project Clarity',
          html: `<p>You have been invited to Project Clarity with the role: <strong>${newRole}</strong>.</p><p>Please click the link below to set up your account and create a password:</p><p><a href="${link}">Set Your Password</a></p>`,
        });

        res.status(200).send({ message: `Successfully invited ${newEmail} as a ${newRole}.` });
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});
