const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3456;
const DEBUG_SIG = process.env.DEBUG_SIG === '1';

// Middleware to capture raw body for signature verification
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// HMAC Signature Verification — matches NewReleases Go reference impl.
// See: https://newreleases.io/webhooks
function verifySignature(req) {
  const secret = process.env.NEWRELEASES_SECRET;
  if (!secret) return true; // Skip if no secret configured

  const sigHeader = req.headers['x-newreleases-signature'];
  const timestamp = req.headers['x-newreleases-timestamp'];
  if (!sigHeader || !timestamp || !req.rawBody) {
    if (DEBUG_SIG) console.error('[sig] missing header/body', { hasSig: !!sigHeader, hasTs: !!timestamp, hasBody: !!req.rawBody });
    return false;
  }

  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(timestamp, 'utf8');
  hmac.update('.', 'utf8');
  hmac.update(req.rawBody); // raw buffer, no string re-encode
  const computed = hmac.digest();

  let received;
  try {
    received = Buffer.from(sigHeader, 'hex');
  } catch (err) {
    if (DEBUG_SIG) console.error('[sig] hex decode failed', err.message);
    return false;
  }

  if (received.length !== computed.length) {
    if (DEBUG_SIG) console.error('[sig] length mismatch', { received: received.length, computed: computed.length });
    return false;
  }

  const valid = crypto.timingSafeEqual(received, computed);
  if (!valid && DEBUG_SIG) {
    console.error('[sig] mismatch', {
      received: received.toString('hex'),
      computed: computed.toString('hex'),
      timestamp,
      bodyLen: req.rawBody.length
    });
  }
  return valid;
}

// Strip HTML tags for Pushover message
function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>?/gm, '');
}

app.get('/health', (_req, res) => res.status(200).send('ok'));

app.post('/webhook/newreleases', async (req, res) => {
  try {
    if (!verifySignature(req)) {
      console.error('Invalid signature');
      return res.status(401).send('Invalid signature');
    }

    const { project, version, note, is_prerelease } = req.body;

    console.log(`Received release: ${project} ${version}`);

    const pushoverUser = process.env.PUSHOVER_USER;
    const pushoverToken = process.env.PUSHOVER_TOKEN;

    if (!pushoverUser || !pushoverToken) {
      console.error('Pushover credentials missing');
      return res.status(500).send('Server configuration error');
    }

    // Format message
    const cleanNote = note && note.message
      ? stripHtml(note.message).substring(0, 500)
      : 'New release available';

    // Use short project name (last path segment) — owner/repo → repo
    const shortName = String(project || '').split('/').filter(Boolean).pop() || project;
    const title = `🚀 ${shortName} ${version}`;
    const url = `https://github.com/${project}/releases/tag/${version}`;
    const priority = is_prerelease ? -1 : 0;

    await axios.post('https://api.pushover.net/1/messages.json', {
      token: pushoverToken,
      user: pushoverUser,
      message: cleanNote,
      title: title,
      url: url,
      url_title: 'View Release',
      priority: priority
    });

    console.log('Notification sent to Pushover');
    res.status(200).send('OK');

  } catch (error) {
    console.error('Error processing webhook:', error.message);
    if (error.response) {
      console.error('Pushover response:', error.response.data);
    }
    res.status(500).send('Internal Server Error');
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
