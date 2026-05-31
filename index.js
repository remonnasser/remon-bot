const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'remon2024';
const FB_TOKEN = process.env.FB_TOKEN || '';
const IG_TOKEN = process.env.IG_TOKEN || '';
const SERVER_URL = process.env.SERVER_URL || '';
const PORT = process.env.PORT || 3000;
const VIDEOS_FILE = path.join(__dirname, 'videos.json');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');

// Create uploads folder if not exists
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function loadVideos() {
  try { return JSON.parse(fs.readFileSync(VIDEOS_FILE, 'utf8')); }
  catch (e) { return []; }
}

function saveVideos(v) {
  fs.writeFileSync(VIDEOS_FILE, JSON.stringify(v, null, 2));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Save base64 attachments to disk and return URL
function processAttachments(attachments) {
  if (!attachments || !attachments.length) return [];
  return attachments.map((att, i) => {
    if (!att.dataUrl) return att; // already processed
    try {
      const ext = att.name.split('.').pop().toLowerCase();
      const filename = `att_${Date.now()}_${i}.${ext}`;
      const base64Data = att.dataUrl.split(',')[1];
      fs.writeFileSync(path.join(UPLOADS_DIR, filename), base64Data, 'base64');
      return { name: att.name, type: att.type, url: `${SERVER_URL}/uploads/${filename}` };
    } catch (e) {
      console.error('Error saving attachment:', e.message);
      return null;
    }
  }).filter(Boolean);
}

// ===== WEBHOOK =====
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const body = req.body;
  if (body.object === 'page') {
    for (const entry of (body.entry || [])) {
      for (const change of (entry.changes || [])) {
        if (change.field === 'feed' && change.value?.item === 'comment' && change.value?.verb === 'add') {
          await handleFbComment(change.value);
        }
      }
    }
  } else if (body.object === 'instagram') {
    for (const entry of (body.entry || [])) {
      for (const change of (entry.changes || [])) {
        if (change.field === 'comments') {
          await handleIgComment(change.value);
        }
      }
    }
  }
});

// ===== FACEBOOK =====
async function handleFbComment(val) {
  try {
    const postId = val.post_id;
    const commentId = val.comment_id;
    const userId = val.from?.id;
    if (!postId || !commentId) return;

    const videos = loadVideos();
    const video = videos.find(v => v.active && v.fbPostId && postId.includes(v.fbPostId));
    if (!video) return;

    const replies = (video.commentReplies || []).filter(r => r?.trim());
    if (!replies.length) return;
    const reply = replies[Math.floor(Math.random() * replies.length)];

    // Reply to comment
    await fetch(`https://graph.facebook.com/v19.0/${commentId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: reply, access_token: FB_TOKEN })
    });

    // Send DM: attachments first, then text
    if (userId) {
      await sendDM(userId, video, FB_TOKEN);
    }

    video.replies = (video.replies || 0) + 1;
    saveVideos(videos);
    console.log('✅ FB: comment replied + DM sent');
  } catch (e) { console.error('FB error:', e.message); }
}

// ===== INSTAGRAM =====
async function handleIgComment(val) {
  try {
    const mediaId = val.media?.id;
    const commentId = val.id;
    const userId = val.from?.id;
    if (!mediaId || !commentId) return;

    const videos = loadVideos();
    const video = videos.find(v => v.active && v.igMediaId === mediaId);
    if (!video) return;

    const replies = (video.commentReplies || []).filter(r => r?.trim());
    if (!replies.length) return;
    const reply = replies[Math.floor(Math.random() * replies.length)];

    // Reply to comment
    await fetch(`https://graph.facebook.com/v19.0/${commentId}/replies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: reply, access_token: IG_TOKEN })
    });

    // Send DM: attachments first, then text
    if (userId) {
      await sendDM(userId, video, IG_TOKEN);
    }

    video.replies = (video.replies || 0) + 1;
    saveVideos(videos);
    console.log('✅ IG: comment replied + DM sent');
  } catch (e) { console.error('IG error:', e.message); }
}

// ===== SEND DM: attachments first, text last =====
async function sendDM(userId, video, token) {
  const attachments = video.attachments || [];

  // 1. Send each attachment first
  for (const att of attachments) {
    if (!att.url) continue;
    const type = att.type === 'image' ? 'image' : att.type === 'video' ? 'video' : 'file';
    await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: userId },
        message: {
          attachment: {
            type,
            payload: { url: att.url, is_reusable: true }
          }
        }
      })
    });
    await sleep(600); // delay between messages
  }

  // 2. Send text message LAST
  if (video.dm?.trim()) {
    await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: userId },
        message: { text: video.dm }
      })
    });
  }
}

// ===== VIDEOS API =====
app.get('/api/videos', (req, res) => res.json(loadVideos()));

app.post('/api/videos', (req, res) => {
  const videos = loadVideos();
  const video = {
    ...req.body,
    id: Date.now(),
    replies: 0,
    active: true,
    attachments: processAttachments(req.body.attachments)
  };
  videos.push(video);
  saveVideos(videos);
  res.json(video);
});

app.put('/api/videos/:id', (req, res) => {
  const videos = loadVideos();
  const idx = videos.findIndex(v => v.id == req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const newAtts = processAttachments(
    (req.body.attachments || []).filter(a => a.dataUrl)
  );
  const existingAtts = (videos[idx].attachments || []).filter(a => a.url);
  videos[idx] = {
    ...videos[idx],
    ...req.body,
    attachments: [...existingAtts, ...newAtts]
  };
  saveVideos(videos);
  res.json(videos[idx]);
});

app.delete('/api/videos/:id', (req, res) => {
  const videos = loadVideos().filter(v => v.id != req.params.id);
  saveVideos(videos);
  res.json({ success: true });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.listen(PORT, () => console.log(`🤖 Bot running on port ${PORT}`));
