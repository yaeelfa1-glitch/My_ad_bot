const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;

const PROMO_PACKAGES = {
  '2_days': { days: 2, price: 1, label: 'يومان مقابل 1 USDT' },
  '5_days': { days: 5, price: 2, label: 'خمسة أيام مقابل 2 USDT' }
};

const REGULAR_AD_REWARD = 0.0003;
const PROMO_AD_REWARD = 0.0005;
const PROMO_AD_DURATION = 10;
const MIN_WITHDRAW_AMOUNT = 0.10;

const db = new sqlite3.Database(path.join(__dirname, 'users.db'), (err) => {
  if (err) {
    console.error('Database opening error:', err.message);
    return;
  }

  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      balance REAL DEFAULT 0,
      last_claim INTEGER DEFAULT 0,
      ads_watched INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      amount REAL NOT NULL,
      wallet TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at INTEGER NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      url TEXT NOT NULL,
      package_key TEXT DEFAULT '2_days',
      duration_days INTEGER DEFAULT 2,
      price REAL DEFAULT 1,
      status TEXT DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      approved_at INTEGER,
      expires_at INTEGER
    )`);

    db.all(`PRAGMA table_info(channels)`, (pragmaErr, columns) => {
      if (!pragmaErr && Array.isArray(columns)) {
        const colNames = columns.map((c) => c.name);
        if (!colNames.includes('package_key')) {
          db.run(`ALTER TABLE channels ADD COLUMN package_key TEXT DEFAULT '2_days'`);
        }
        if (!colNames.includes('duration_days')) {
          db.run(`ALTER TABLE channels ADD COLUMN duration_days INTEGER DEFAULT 2`);
        }
        if (!colNames.includes('price')) {
          db.run(`ALTER TABLE channels ADD COLUMN price REAL DEFAULT 1`);
        }
        if (!colNames.includes('approved_at')) {
          db.run(`ALTER TABLE channels ADD COLUMN approved_at INTEGER`);
        }
        if (!colNames.includes('expires_at')) {
          db.run(`ALTER TABLE channels ADD COLUMN expires_at INTEGER`);
        }
      }
    });
  });
});

app.use(express.json());
app.use(express.static(path.join(__dirname)));

function normalizeUserId(rawId) {
  const cleaned = String(rawId || '').trim();
  if (!cleaned || cleaned.length > 100) return null;
  return cleaned;
}

function isValidHttpUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch (e) {
    return false;
  }
}

function round6(num) {
  return Math.round((Number(num) + Number.EPSILON) * 1000000) / 1000000;
}

function ensureUserExists(userId, callback) {
  db.get(
    `SELECT id, balance, last_claim, ads_watched FROM users WHERE id = ?`,
    [userId],
    (err, row) => {
      if (err) return callback(err);
      if (row) {
        return callback(null, {
          id: row.id,
          balance: round6(row.balance || 0),
          last_claim: Number(row.last_claim || 0),
          ads_watched: Number(row.ads_watched || 0)
        });
      }

      db.run(
        `INSERT INTO users (id, balance, last_claim, ads_watched) VALUES (?, 0, 0, 0)`,
        [userId],
        (insertErr) => {
          if (insertErr) return callback(insertErr);
          return callback(null, {
            id: userId,
            balance: 0,
            last_claim: 0,
            ads_watched: 0
          });
        }
      );
    }
  );
}

app.get('/api/ads', (req, res) => {
  const ads = [
    {
      id: 'ad_1',
      title: 'إعلان راعي رئيسي - زيارة سريعة',
      reward: REGULAR_AD_REWARD,
      duration: 10,
      url: 'https://t.me'
    }
  ];
  res.json({ success: true, ads });
});

app.get('/api/promo-ads', (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  db.all(
    `SELECT id, url, duration_days, price, expires_at
     FROM channels
     WHERE status = 'approved' AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY id DESC`,
    [now],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ success: false, message: err.message });
      }
      const promoAds = (rows || []).map((row) => ({
        id: `promo_${row.id}`,
        channelId: row.id,
        title: `إعلان ترويجي: ${row.url}`,
        url: row.url,
        reward: PROMO_AD_REWARD,
        duration: PROMO_AD_DURATION,
        duration_days: row.duration_days,
        price: row.price,
        expires_at: row.expires_at
      }));
      res.json({ success: true, promoAds });
    }
  );
});

app.get('/api/user', (req, res) => {
  const userId = normalizeUserId(req.query.id);
  if (!userId) {
    return res.status(400).json({ success: false, error: 'userId is required' });
  }

  ensureUserExists(userId, (err, user) => {
    if (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
    res.json({
      success: true,
      balance: user.balance,
      last_claim: user.last_claim,
      ads_watched: user.ads_watched
    });
  });
});

app.post('/api/daily-checkin', (req, res) => {
  const userId = normalizeUserId(req.body && req.body.userId);
  if (!userId) {
    return res.status(400).json({ success: false, message: 'معرف المستخدم مطلوب.' });
  }

  const now = Math.floor(Date.now() / 1000);
  const rewardAmount = 0.0005;

  ensureUserExists(userId, (ensureErr, user) => {
    if (ensureErr) {
      return res.status(500).json({ success: false, message: ensureErr.message });
    }

    if (now - user.last_claim < 86400) {
      return res.json({ success: false, message: 'تم استلام المكافأة اليومية مسبقاً.' });
    }

    const nextBalance = round6(user.balance + rewardAmount);
    db.run(
      `UPDATE users SET balance = ?, last_claim = ? WHERE id = ?`,
      [nextBalance, now, userId],
      (updateErr) => {
        if (updateErr) {
          return res.status(500).json({ success: false, message: updateErr.message });
        }
        res.json({ success: true, reward: rewardAmount, balance: nextBalance });
      }
    );
  });
});

app.post('/api/complete-ad', (req, res) => {
  const userId = normalizeUserId(req.body && req.body.userId);
  const isPromo = Boolean(req.body && req.body.isPromo);

  if (!userId) {
    return res.status(400).json({ success: false, message: 'معرف المستخدم مطلوب.' });
  }

  const rewardAmount = isPromo ? PROMO_AD_REWARD : REGULAR_AD_REWARD;

  ensureUserExists(userId, (ensureErr, user) => {
    if (ensureErr) {
      return res.status(500).json({ success: false, message: ensureErr.message });
    }

    const nextBalance = round6(user.balance + rewardAmount);
    const nextAdsWatched = user.ads_watched + 1;

    db.run(
      `UPDATE users SET balance = ?, ads_watched = ? WHERE id = ?`,
      [nextBalance, nextAdsWatched, userId],
      (updateErr) => {
        if (updateErr) {
          return res.status(500).json({ success: false, message: updateErr.message });
        }
        res.json({
          success: true,
          reward: rewardAmount,
          balance: nextBalance,
          ads_watched: nextAdsWatched
        });
      }
    );
  });
});

app.get('/api/channels', (req, res) => {
  const userId = normalizeUserId(req.query.userId);
  if (!userId) {
    return res.status(400).json({ success: false, message: 'معرف المستخدم مطلوب.' });
  }

  db.all(
    `SELECT id, url, package_key, duration_days, price, status, created_at, expires_at
     FROM channels
     WHERE user_id = ?
     ORDER BY id DESC`,
    [userId],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ success: false, message: err.message });
      }
      res.json({ success: true, channels: rows || [] });
    }
  );
});

app.post('/api/add-channel', (req, res) => {
  const userId = normalizeUserId(req.body && req.body.userId);
  const trimmedUrl = String((req.body && req.body.url) || '').trim();
  const packageKey = Object.prototype.hasOwnProperty.call(PROMO_PACKAGES, req.body && req.body.packageKey)
    ? req.body.packageKey
    : '2_days';
  const selectedPkg = PROMO_PACKAGES[packageKey];
  const now = Math.floor(Date.now() / 1000);

  if (!userId) {
    return res.status(400).json({ success: false, message: 'معرف المستخدم مطلوب.' });
  }
  if (!trimmedUrl || !isValidHttpUrl(trimmedUrl)) {
    return res.status(400).json({ success: false, message: 'يرجى إدخال رابط صحيح يبدأ بـ https:// أو http://' });
  }

  ensureUserExists(userId,
