const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const app = express();
const PORT = process.env.PORT || 3000;

const db = new sqlite3.Database('./users.db', (err) => {
  if (err) {
    console.error('Database opening error:', err.message);
  } else {
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      balance REAL DEFAULT 0,
      last_claim INTEGER DEFAULT 0,
      ads_watched INTEGER DEFAULT 0
    )`);
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.get('/api/user', (req, res) => {
  const userId = req.query.id;
  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  db.get(`SELECT balance, last_claim FROM users WHERE id = ?`, [userId], (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (row) {
      res.json({ balance: row.balance, last_claim: row.last_claim });
    } else {
      db.run(`INSERT INTO users (id, balance, last_claim) VALUES (?, 0, 0)`, [userId], (insertErr) => {
        if (insertErr) {
          return res.status(500).json({ error: insertErr.message });
        }
        res.json({ balance: 0, last_claim: 0 });
      });
    }
  });
});

app.post('/api/daily-checkin', (req, res) => {
  const { userId } = req.body;
  const now = Math.floor(Date.now() / 1000);

  db.get(`SELECT last_claim FROM users WHERE id = ?`, [userId], (err, row) => {
    if (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
    if (row && now - row.last_claim < 86400) {
      return res.json({ success: false, message: 'تم استلام المكافأة اليومية مسبقاً.' });
    }

    const upsertQuery = `
      INSERT INTO users (id, balance, last_claim) VALUES (?, 0.0005, ?)
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
  const upsertQuery = `
    INSERT INTO users (id, balance, ads_watched) VALUES (?, 0.0003, 1)
    ON CONFLICT(id) DO UPDATE SET balance = balance + 0.0003, ads_watched = ads_watched + 1
  `;
  db.run(upsertQuery, [userId], (err) => {
    if (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
    res.json({ success: true, reward: 0.0003 });
  });
});

app.post('/api/withdraw', (req, res) => {
  const { userId, amount, wallet } = req.body;
  const numericAmount = Number(amount);

  if (!numericAmount || numericAmount < 0.10) {
    return res.json({ success: false, message: 'الحد الأدنى للسحب هو 0.10 USDT.' });
  }

  db.get(`SELECT balance FROM users WHERE id = ?`, [userId], (err, row) => {
    if (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
    if (row && row.balance >= numericAmount) {
      db.run(`UPDATE users SET balance = balance - ? WHERE id = ?`, [numericAmount, userId], (updateErr) => {
        if (updateErr) {
          return res.status(500).json({ success: false, message: updateErr.message });
        }
        res.json({ success: true, message: 'تم إرسال طلب السحب.' });
      });
    } else {
      res.json({ success: false, message: 'الرصيد غير كافٍ.' });
    }
  });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
