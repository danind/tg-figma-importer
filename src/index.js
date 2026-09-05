import express from 'express';
import cors from 'cors';
import { parseTelegramPost } from './telegramParser.js';

const app = express();
app.use(cors());
app.use(express.json());

app.post('/api/parse', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'no_url' });

  try {
    const result = await parseTelegramPost(url);

    if (result.error === 'invalid_link') {
      return res.status(400).json(result);
    }
    // private_or_unavailable is returned as a normal 200 response so the
    // plugin UI can show a clean "channel is private" message.
    return res.json(result);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`TG post importer backend on :${PORT}`));
