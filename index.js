const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const app = express();
const PORT = process.env.PORT || 3000;

const db = new sqlite3.Database('./users.db', (err) => {
  if (err) {
    console.error('Database opening error:', err.message);
  } else {
    db.serialize(() => {
      db.run(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        balance REAL DEFAULT 0,
        last_claim INTEGER DEFAULT 0,
        ads_watched INTEGER DEFAULT 0
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS withdrawals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        amount REAL,
        wallet TEXT,
        status TEXT DEFAULT 'pending',
        created_at INTEGER
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        url TEXT,
        status TEXT DEFAULT 'pending',
        created_at INTEGER
      )`);
    });
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// مسار جلب الإعلانات للواجهة
app.get('/api/ads', (req, res) => {
  const ads = [
    {
      id: 'ad_1',
      title: 'شاهد الإعلان واحصل على مكافأة',
      reward: 0.0003,
      duration: 5,
      url: 'https://t.me'
    }
  ];
  res.json({ success: true, ads });
});

app.get('/api/user', (req, res) => {
  const userId = req.query.id;
  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  db.get(`SELECT balance, last_claim, ads_watched FROM users WHERE id = ?`, [userId], (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (row) {
      res.json({ balance: row.balance, last_claim: row.last_claim, ads_watched: row.ads_watched });
    } else {
      db.run(`INSERT INTO users (id, balance, last_claim, ads_watched) VALUES (?, 0, 0, 0)`, [userId], (insertErr) => {
        if (insertErr) {
          return res.status(500).json({ error: insertErr.message });
        }
        res.json({ balance: 0, last_claim: 0, ads_watched: 0 });
      });
    }
  });
});

app.post('/api/daily-checkin', (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ success: false, message: 'معرف المستخدم مطلوب.' });
  }

  const now = Math.floor(Date.now() / 1000);

  db.get(`SELECT last_claim FROM users WHERE id = ?`, [userId], (err, row) => {
    if (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
    if (row && now - row.last_claim < 86400) {
      return res.json({ success: false, message: 'تم استلام المكافأة اليومية مسبقاً.' });
    }

    const upsertQuery = `
      INSERT INTO users (id, balance, last_claim, ads_watched) VALUES (?, 0.0005, ?, 0)
      ON CONFLICT(id) DO UPDATE SET balance = balance + 0.0005, last_claim = excluded.last_claim
    `;
    db.run(upsertQuery, [userId, now], (updateErr) => {
      if (updateErr) {
        return res.status(500).json({ success: false, message: updateErr.message });
      }
      res.json({ success: true, reward: 0.0005 });
    });
  });
});

app.post('/api/complete-ad', (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ success: false, message: 'معرف المستخدم مطلوب.' });
  }

  const upsertQuery = `
    INSERT INTO users (id, balance, last_claim, ads_watched) VALUES (?, 0.0003, 0, 1)
    ON CONFLICT(id) DO UPDATE SET balance = balance + 0.0003, ads_watched = ads_watched + 1
  `;
  db.run(upsertQuery, [userId], (err) => {
    if (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
    res.json({ success: true, reward: 0.0003 });
  });
});

app.get('/api/channels', (req, res) => {
  const userId = req.query.userId;
  if (!userId) {
    return res.status(400).json({ success: false, message: 'معرف المستخدم مطلوب.' });
  }

  db.all(
    `SELECT id, url, status, created_at FROM channels WHERE user_id = ? ORDER BY id DESC`,
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
  const { userId, url } = req.body;
  const trimmedUrl = String(url || '').trim();
  const now = Math.floor(Date.now() / 1000);

  if (!userId) {
    return res.status(400).json({ success: false, message: 'معرف المستخدم مطلوب.' });
  }
  if (!trimmedUrl) {
    return res.status(400).json({ success: false, message: 'يرجى إدخال رابط صحيح.' });
  }

  db.run(
    `INSERT INTO channels (user_id, url, status, created_at) VALUES (?, ?, 'pending', ?)`,
    [userId, trimmedUrl, now],
    function (err) {
      if (err) {
        return res.status(500).json({ success: false, message: err.message });
      }
      res.json({ success: true, id: this.lastID, status: 'pending' });
    }
  );
});

app.get('/api/withdraw-history', (req, res) => {
  const userId = req.query.id;
  if (!userId) {
    return res.status(400).json({ success: false, message: 'معرف المستخدم مطلوب.' });
  }

  db.all(
    `SELECT id, amount, wallet, status, created_at FROM withdrawals WHERE user_id = ? ORDER BY id DESC`,
    [userId],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ success: false, message: err.message });
      }
      res.json({ success: true, history: rows || [] });
    }
  );
});

app.post('/api/withdraw', (req, res) => {
  const { userId, amount, wallet } = req.body;
  const numericAmount = Number(amount);
  const now = Math.floor(Date.now() / 1000);

  if (!userId) {
    return res.json({ success: false, message: 'معرف المستخدم مطلوب.' });
  }
  if (!wallet || String(wallet).trim().length < 5) {
    return res.json({ success: false, message: 'يرجى إدخال عنوان محفظة صحيح.' });
  }
  if (!numericAmount || numericAmount < 0.10) {
    return res.json({ success: false, message: 'الحد الأدنى للسحب هو 0.10 USDT.' });
  }

  db.get(`SELECT balance FROM users WHERE id = ?`, [userId], (err, row) => {
    if (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
    if (row && row.balance >= numericAmount) {
      db.serialize(() => {
        db.run(`UPDATE users SET balance = balance - ? WHERE id = ?`, [numericAmount, userId], (updateErr) => {
          if (updateErr) {
            return res.status(500).json({ success: false, message: updateErr.message });
          }
          db.run(
            `INSERT INTO withdrawals (user_id, amount, wallet, created_at) VALUES (?, ?, ?, ?)`,
            [userId, numericAmount, String(wallet).trim(), now],
            (insertErr) => {
              if (insertErr) {
                return res.status(500).json({ success: false, message: insertErr.message });
              }
              res.json({ success: true, message: 'تم إرسال طلب السحب.' });
            }
          );
        });
      });
    } else {
      res.json({ success: false, message: 'الرصيد غير كافٍ.' });
    }
  });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
