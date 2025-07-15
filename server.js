require('dotenv').config();
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '13mrmzipddRx1puJ4DQHy1zhKCbcOJg3D1NlahFOE900';
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const fs = require('fs');
const { google } = require('googleapis');
const path = require('path');

const app = express();
const db = new sqlite3.Database('./users.db');
const SECRET_KEY = 'pR+_8eVEc#*roS$LqO44ET';

app.use(cors());
app.use(express.json());

// --- GOOGLE SHEETS SETUP ---

const CREDENTIALS_PATH = '/etc/secrets/google-credentials.json';  // Render secret file path

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

function getGoogleSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDENTIALS_PATH,
    scopes: SCOPES,
  });
  return google.sheets({ version: 'v4', auth });
}

// --- END GOOGLE SHEETS SETUP ---

// --- INIT DB TABLES IF NOT EXIST ---
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT,
    last_name TEXT,
    username TEXT UNIQUE,
    password_hash TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS creators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT,
    sobrenome TEXT,
    responsavel TEXT,
    instagram TEXT,
    tiktok TEXT,
    telefone TEXT,
    whatsapp TEXT,
    obs TEXT,
    username TEXT,
    created_at DATETIME DEFAULT (datetime('now', 'localtime'))
  )`);
});

// --- JWT Auth Middleware ---
function authenticateToken(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ message: 'No token provided' });
  const token = auth.split(' ')[1];
  try {
    req.user = jwt.verify(token, SECRET_KEY);
    next();
  } catch {
    res.status(401).json({ message: 'Invalid token' });
  }
}

// --- Register ---
app.post('/api/register', (req, res) => {
  const { firstName, lastName, username, password } = req.body;
  if (!username || !password) return res.status(400).json({ message: 'Dados incompletos.' });

  db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
    if (user) return res.status(400).json({ message: 'Usuário já existe.' });
    const hash = bcrypt.hashSync(password, 10);
    db.run(
      'INSERT INTO users (first_name, last_name, username, password_hash) VALUES (?, ?, ?, ?)',
      [firstName, lastName, username, hash],
      function (err) {
        if (err) return res.status(500).json({ message: 'Erro ao registrar.' });
        res.json({ message: 'Usuário registrado com sucesso!' });
      }
    );
  });
});

// --- Login ---
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(400).json({ message: "Usuário ou senha inválidos" });
    }
    const token = jwt.sign({ username }, SECRET_KEY, { expiresIn: '2h' });
    res.json({
      firstName: user.first_name,
      lastName: user.last_name,
      username: user.username,
      token
    });
  });
});

// --- Get creators for user ---
app.get('/api/creators', authenticateToken, (req, res) => {
  const username = req.query.username || req.user.username;
  db.all('SELECT * FROM creators WHERE username = ? ORDER BY created_at DESC', [username], (err, rows) => {
    if (err) return res.status(500).json([]);
    res.json(rows);
  });
});

// --- Add creator ---
app.post('/api/creators', authenticateToken, async (req, res) => {
  const { nome, sobrenome, responsavel, instagram, tiktok, telefone, whatsapp, obs, username } = req.body;
  const user = username || req.user.username;
  db.run(
    `INSERT INTO creators (nome, sobrenome, responsavel, instagram, tiktok, telefone, whatsapp, obs, username)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [nome, sobrenome, responsavel, instagram, tiktok, telefone, whatsapp, obs, user],
    async function (err) {
      if (err) {
        return res.status(500).json({ message: 'Erro ao adicionar creator' });
      }
      // Fetch the inserted row (includes full timestamp)
      db.get('SELECT * FROM creators WHERE id = ?', [this.lastID], async (err, row) => {
        if (err || !row) {
          return res.status(500).json({ message: 'Erro ao buscar registro criado' });
        }
        // Try to sync to Google Sheets immediately
        try {
          const sheets = getGoogleSheetsClient();
          const newRow = [
            row.id,                   // UNIQUE ID as first column!
            row.username || '',
            row.created_at || '',
            row.nome || '',
            row.sobrenome || '',
            row.responsavel || '',
            row.instagram || '',
            row.tiktok || '',
            row.telefone || '',
            row.whatsapp || '',
            row.obs || ''
          ];
          // Append to the bottom of the sheet
          await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Sheet1', // Use sheet name only, NOT a cell range!
            valueInputOption: 'USER_ENTERED',
            insertDataOption: 'INSERT_ROWS',
            resource: { values: [newRow] }
          });

          res.json({ ...row, sheetSync: true });
        } catch (error) {
          res.json({ ...row, sheetSync: false, error: 'Não foi possível sincronizar com o Google Sheets agora.' });
        }
      });
    }
  );
});

// --- Delete all creators for user ---
app.delete('/api/creators', authenticateToken, (req, res) => {
  const username = req.user.username;
  db.run('DELETE FROM creators WHERE username = ?', [username], function (err) {
    if (err) return res.status(500).json({ message: 'Erro ao excluir creators.' });
    res.json({ message: 'Todos os creators excluídos.' });
  });
});

// --- Update a creator ---
app.put('/api/creators/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      nome, sobrenome, responsavel, instagram, tiktok,
      telefone, whatsapp, obs
    } = req.body;

    // Fetch record for this ID
    const record = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM creators WHERE id = ?', [id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    if (!record) return res.status(404).json({ message: 'Creator not found' });

    // Security: Only allow update by owner
    if (record.username !== req.user.username) {
      return res.status(403).json({ message: 'You do not have permission to edit this record.' });
    }

    // Update SQLite
    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE creators SET nome = ?, sobrenome = ?, responsavel = ?, instagram = ?, tiktok = ?, telefone = ?, whatsapp = ?, obs = ? WHERE id = ?`,
        [nome, sobrenome, responsavel, instagram, tiktok, telefone, whatsapp, obs, id],
        function (err) { if (err) reject(err); else resolve(); }
      );
    });

    // Google Sheets logic
    try {
      const sheets = getGoogleSheetsClient();
      const readRes = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Sheet1'
      });
      const rows = readRes.data.values;
      const idCol = rows[0].indexOf('ID');
      const usernameCol = rows[0].indexOf('USUÁRIO');
      const idRow = rows.findIndex((row, idx) =>
        idx > 0 && row[idCol] == id && row[usernameCol] === req.user.username
      );
      const sheetRowNumber = idRow + 1;  // header is row 1 (idx 0), data starts row 2 (idx 1)
      if (idRow >= 1) {
        const values = [
          id,
          req.user.username,
          record.created_at,
          nome,
          sobrenome,
          responsavel,
          instagram,
          tiktok,
          telefone,
          whatsapp,
          obs
        ];
        const updateRange = `Sheet1!A${sheetRowNumber}:K${sheetRowNumber}`; // A:K for 11 columns (ID, USUÁRIO, DATA, ...)
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: updateRange,
          valueInputOption: 'RAW',
          requestBody: { values: [values] }
        });
      } else {
        console.warn('No matching row found in sheet for update!');
      }
    } catch (err) {
      console.error('Google Sheets update failed:', err.message);
    }

    res.json({ message: 'Creator updated successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Erro ao editar Creator' });
  }
});

// --- Delete single creator ---
app.delete('/api/creators/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    // Get record before deleting
    const record = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM creators WHERE id = ?', [id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    if (!record) return res.status(404).json({ message: 'Creator not found' });

    // Security: Only allow delete by owner
    if (record.username !== req.user.username) {
      return res.status(403).json({ message: 'You do not have permission to delete this record.' });
    }

    // Google Sheets logic
    try {
      const sheets = getGoogleSheetsClient();
      const readRes = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Sheet1'
      });
      const rows = readRes.data.values;
      const idCol = rows[0].indexOf('ID');
      const usernameCol = rows[0].indexOf('USUÁRIO');
      const idRow = rows.findIndex((row, idx) =>
        idx > 0 && row[idCol] == id && row[usernameCol] === req.user.username
      );
      const sheetRowNumber = idRow + 1; // header is row 1 (idx 0), data starts row 2 (idx 1)
      if (idRow >= 1) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: SPREADSHEET_ID,
          requestBody: {
            requests: [
              {
                deleteDimension: {
                  range: {
                    sheetId: 0,
                    dimension: 'ROWS',
                    startIndex: sheetRowNumber - 1, // zero-based
                    endIndex: sheetRowNumber        // exclusive
                  }
                }
              }
            ]
          }
        });
      } else {
        console.warn('No matching row found in sheet for delete!');
      }
    } catch (err) {
      console.error('Google Sheets delete failed:', err.message);
    }

    // Delete from SQLite
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM creators WHERE id = ?', [id], function (err) {
        if (err) reject(err); else resolve();
      });
    });

    res.json({ message: 'Creator deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Erro ao excluir o Creator.' });
  }
});

// [CALENDAR PATCH - ADDED]

// === Calendário: Google Sheets-backed Calendar API ===

// Helpers for Calendário
function getCalendarSheetRows(sheets) {
  return sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Calendário'
  }).then(res => res.data.values);
}

// GET all calendar locations (all dates)
app.get('/api/calendar', authenticateToken, async (req, res) => {
  try {
    const sheets = getGoogleSheetsClient();
    const rows = await getCalendarSheetRows(sheets);
    if (!rows || rows.length < 2) return res.json([]); // Only header or empty
    const header = rows[0];
    // Find column indices for DATA, LOCALIZAÇÃO, NOTAS
    const idCol = header.indexOf('ID');
    const dateCol = header.indexOf('DATA');
    const locCol = header.indexOf('LOCALIZAÇÃO');
    const notesCol = header.indexOf('NOTAS');
    // Map all data rows
    const result = rows.slice(1).map(r => ({
      id: r[idCol] || '',
      data: r[dateCol] || '',
      localizacao: r[locCol] || '',
      notas: notesCol >= 0 ? (r[notesCol] || '') : ''
    }));
    res.json(result);
  } catch (err) {
    console.error('GET /api/calendar error:', err);
    res.status(500).json({ message: 'Erro ao ler o calendário' });
  }
});

// POST new calendar location
app.post('/api/calendar', authenticateToken, async (req, res) => {
  try {
    const { data, localizacao, notas } = req.body;
    if (!data || !localizacao) return res.status(400).json({ message: 'DATA e LOCALIZAÇÃO são obrigatórios.' });

    const sheets = getGoogleSheetsClient();
    const rows = await getCalendarSheetRows(sheets);

    // Find current max ID
    let maxId = 0;
    if (rows && rows.length > 1) {
      const idCol = rows[0].indexOf('ID');
      for (let i = 1; i < rows.length; ++i) {
        const idVal = rows[i][idCol];
        if (idVal && !isNaN(Number(idVal))) {
          maxId = Math.max(maxId, Number(idVal));
        }
      }
    }
    const newId = String(maxId + 1);

    // Append to sheet
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Calendário',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      resource: { values: [[newId, data, localizacao, notas || '']] }
    });

    res.json({ id: newId, data, localizacao, notas: notas || '' });
  } catch (err) {
    console.error('POST /api/calendar error:', err);
    res.status(500).json({ message: 'Erro ao adicionar local no calendário' });
  }
});

// PUT update a calendar location by ID
app.put('/api/calendar/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { data, localizacao, notas } = req.body;
    const sheets = getGoogleSheetsClient();
    const rows = await getCalendarSheetRows(sheets);
    if (!rows || rows.length < 2) return res.status(404).json({ message: 'Calendário vazio.' });

    const header = rows[0];
    const idCol = header.indexOf('ID');
    const dateCol = header.indexOf('DATA');
    const locCol = header.indexOf('LOCALIZAÇÃO');
    const notesCol = header.indexOf('NOTAS');
    const targetRowIdx = rows.findIndex((r, idx) => idx > 0 && r[idCol] == id);
    if (targetRowIdx < 1) return res.status(404).json({ message: 'Registro não encontrado.' });

    // Update in sheet
    const updateRange = `Calendário!A${targetRowIdx + 1}:D${targetRowIdx + 1}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: updateRange,
      valueInputOption: 'RAW',
      resource: { values: [[id, data, localizacao, notas || '']] }
    });

    res.json({ id, data, localizacao, notas: notas || '' });
  } catch (err) {
    console.error('PUT /api/calendar/:id error:', err);
    res.status(500).json({ message: 'Erro ao atualizar local do calendário' });
  }
});

// DELETE a calendar location by ID
app.delete('/api/calendar/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const sheets = getGoogleSheetsClient();
    const rows = await getCalendarSheetRows(sheets);
    if (!rows || rows.length < 2) return res.status(404).json({ message: 'Calendário vazio.' });
    const header = rows[0];
    const idCol = header.indexOf('ID');
    const rowIdx = rows.findIndex((r, idx) => idx > 0 && r[idCol] == id);
    if (rowIdx < 1) return res.status(404).json({ message: 'Registro não encontrado.' });

    // Remove row in sheet (sheetId = 0 for first sheet, or find correct id by name)
    // Find sheetId by name:
    const sheetsApi = sheets.spreadsheets;
    const metadata = await sheetsApi.get({ spreadsheetId: SPREADSHEET_ID });
    const sheet = metadata.data.sheets.find(sh => sh.properties.title === 'Calendário');
    if (!sheet) return res.status(404).json({ message: 'Sheet não encontrada.' });
    const sheetId = sheet.properties.sheetId;

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId: sheetId,
                dimension: 'ROWS',
                startIndex: rowIdx, // zero-based, includes header
                endIndex: rowIdx + 1
              }
            }
          }
        ]
      }
    });

    res.json({ message: 'Registro removido com sucesso.' });
  } catch (err) {
    console.error('DELETE /api/calendar/:id error:', err);
    res.status(500).json({ message: 'Erro ao remover local do calendário' });
  }
});

// [END CALENDAR PATCH]


// Serve static files from React build

app.use(express.static('build'));
app.get('*', (req, res) => {
  res.sendFile('index.html', { root: 'build' });
});


const PORT = process.env.PORT || 4000;
console.log('Using port:', PORT);
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
