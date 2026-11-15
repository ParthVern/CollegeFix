'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');

const CATEGORIES = [
  'Electricity',
  'Water Supply',
  'Internet / Wi-Fi',
  'Classroom Maintenance',
  'Hostel Issues',
  'Washroom / Sanitation',
  'Library',
  'Security',
  'Other',
];
const STATUSES = ['Submitted', 'Under Review', 'In Progress', 'Resolved', 'Rejected'];
const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];
const ALLOWED_TRANSITIONS = {
  Submitted: ['Under Review'],
  'Under Review': ['In Progress', 'Rejected'],
  'In Progress': ['Resolved', 'Rejected'],
  Resolved: [],
  Rejected: [],
};
const SESSION_DAYS = 7;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const IMAGE_TYPES = {
  'image/jpeg': { extension: '.jpg', signature: (buffer) => buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff },
  'image/png': { extension: '.png', signature: (buffer) => buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  'image/webp': { extension: '.webp', signature: (buffer) => buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' },
};

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt}:${hash.toString('hex')}`;
}

function verifyPassword(password, storedHash) {
  const [salt, encodedHash] = String(storedHash).split(':');
  if (!salt || !encodedHash || !/^[a-f0-9]{128}$/i.test(encodedHash)) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(actual, Buffer.from(encodedHash, 'hex'));
}

function createSchema(db) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('student', 'admin')),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS complaints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      location TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Submitted' CHECK (status IN ('Submitted', 'Under Review', 'In Progress', 'Resolved', 'Rejected')),
      priority TEXT NOT NULL DEFAULT 'Medium' CHECK (priority IN ('Low', 'Medium', 'High', 'Urgent')),
      admin_response TEXT NOT NULL DEFAULT '',
      image_name TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS complaints_student ON complaints(student_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS complaints_status ON complaints(status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS complaint_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      complaint_id INTEGER NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
      old_status TEXT,
      new_status TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      changed_by INTEGER NOT NULL REFERENCES users(id),
      changed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS complaint_history_complaint ON complaint_history(complaint_id, changed_at DESC);
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      complaint_id INTEGER NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
      message TEXT NOT NULL,
      read_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, created_at DESC);
  `);
}

function seedDemoData(db) {
  const count = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  if (count > 0) return;

  const now = new Date();
  const timestamp = (daysAgo) => new Date(now.getTime() - daysAgo * 86400000).toISOString();
  const insertUser = db.prepare('INSERT INTO users (full_name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)');
  const admin = insertUser.run('CampusFix Administrator', 'admin@campusfix.edu', hashPassword('CampusFixAdmin!2026'), 'admin', timestamp(60));
  const student = insertUser.run('Aarav Sharma', 'student@campusfix.edu', hashPassword('CampusFixStudent!2026'), 'student', timestamp(25));
  const insertComplaint = db.prepare(`
    INSERT INTO complaints (student_id, title, description, category, location, status, priority, admin_response, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertHistory = db.prepare(`
    INSERT INTO complaint_history (complaint_id, old_status, new_status, note, changed_by, changed_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertNotification = db.prepare(`
    INSERT INTO notifications (user_id, complaint_id, message, created_at)
    VALUES (?, ?, ?, ?)
  `);

  const examples = [
    { title: 'Water cooler on the second floor is leaking', description: 'The cooler outside the chemistry lab has been dripping onto the floor since yesterday. Please take a look before the next class.', category: 'Water Supply', location: 'Science Block · 2nd floor', status: 'In Progress', priority: 'High', response: 'A maintenance technician has been assigned and will visit this afternoon.', days: 0.3 },
    { title: 'Wi-Fi drops in the library reading room', description: 'The campus network disconnects every few minutes in the east-side reading area, especially around the study pods.', category: 'Internet / Wi-Fi', location: 'Central Library · Reading Room', status: 'Under Review', priority: 'Medium', response: '', days: 1.4 },
    { title: 'Projector is not working in Room B-204', description: 'The projector turns on but shows a blank image. We have checked the HDMI cable and tried restarting it.', category: 'Classroom Maintenance', location: 'Academic Block B · Room 204', status: 'Resolved', priority: 'Low', response: 'The display cable was replaced. Please let us know if the issue returns.', days: 5 },
    { title: 'Light fixtures need attention near hostel entrance', description: 'Two lights beside the main entrance have stopped working, making the path difficult to see after evening study hours.', category: 'Electricity', location: 'North Hostel · Main entrance', status: 'Submitted', priority: 'Medium', response: '', days: 0.08 },
    { title: 'Reading room washbasin drain is blocked', description: 'Water is collecting around the washbasin and the area needs cleaning.', category: 'Washroom / Sanitation', location: 'Central Library · Ground floor', status: 'Rejected', priority: 'Low', response: 'This drain is managed by the library facilities team. Your report has been forwarded to them; please contact the librarian directly for follow-up.', days: 9 },
  ];

  for (const example of examples) {
    const createdAt = timestamp(example.days);
    const updatedAt = example.status === 'Submitted'
      ? createdAt
      : timestamp(example.days * (example.status === 'Under Review' ? 0.7 : example.status === 'In Progress' ? 0.45 : 0.15));
    const result = insertComplaint.run(
      student.lastInsertRowid,
      example.title,
      example.description,
      example.category,
      example.location,
      example.status,
      example.priority,
      example.response,
      createdAt,
      updatedAt,
    );
    const complaintId = result.lastInsertRowid;
    insertHistory.run(complaintId, null, 'Submitted', 'Complaint submitted by the student.', student.lastInsertRowid, createdAt);
    if (example.status !== 'Submitted') {
      insertHistory.run(complaintId, 'Submitted', 'Under Review', 'Complaint received by the campus team.', admin.lastInsertRowid, timestamp(example.days * 0.7));
      if (['In Progress', 'Resolved'].includes(example.status)) {
        insertHistory.run(complaintId, 'Under Review', 'In Progress', 'A facilities team member has been assigned.', admin.lastInsertRowid, timestamp(example.days * 0.45));
      }
      if (['Resolved', 'Rejected'].includes(example.status)) {
        const precedingStatus = example.status === 'Resolved' ? 'In Progress' : 'Under Review';
        insertHistory.run(complaintId, precedingStatus, example.status, example.response, admin.lastInsertRowid, updatedAt);
      }
      if (example.response) {
        insertNotification.run(student.lastInsertRowid, complaintId, `Update on “${example.title}”: ${example.response}`, updatedAt);
      }
    }
  }
}

function safeUser(row) {
  if (!row) return null;
  return { id: row.id, name: row.full_name, email: row.email, role: row.role };
}

function createApp(options = {}) {
  const dataDir = options.dataDir || path.join(__dirname, 'data');
  const uploadDir = options.uploadDir || path.join(dataDir, 'uploads');
  const dbPath = options.dbPath || path.join(dataDir, 'campusfix.sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(uploadDir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  createSchema(db);
  if (options.seed !== false) seedDemoData(db);
  const dummyPasswordHash = hashPassword(crypto.randomBytes(32).toString('hex'));

  let sessionSecret = options.sessionSecret || process.env.SESSION_SECRET;
  if (!sessionSecret) {
    const secretPath = path.join(dataDir, '.session-secret');
    if (fs.existsSync(secretPath)) {
      sessionSecret = fs.readFileSync(secretPath, 'utf8');
    } else {
      sessionSecret = crypto.randomBytes(48).toString('hex');
      fs.writeFileSync(secretPath, sessionSecret, { flag: 'wx', mode: 0o600 });
    }
  }

  const app = express();
  const loginAttempts = new Map();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    if (process.env.NODE_ENV === 'production') res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });
  app.use(express.json({ limit: '4.3mb', strict: true }));
  app.use(express.urlencoded({ extended: false, limit: '16kb' }));

  const signatureFor = (id) => crypto.createHmac('sha256', sessionSecret).update(id).digest('hex');
  const cookieName = 'campusfix.sid';
  const setSessionCookie = (res, value, maxAge) => {
    const attributes = [`${cookieName}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
    if (process.env.NODE_ENV === 'production') attributes.push('Secure');
    res.setHeader('Set-Cookie', attributes.join('; '));
  };
  const readCookie = (req) => {
    const value = req.headers.cookie || '';
    const item = value.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`));
    if (!item) return null;
    const [id, signature] = item.slice(cookieName.length + 1).split('.');
    if (!id || !signature || !/^[a-f0-9]{64}$/i.test(id) || !/^[a-f0-9]{64}$/i.test(signature)) return null;
    const expected = Buffer.from(signatureFor(id), 'hex');
    const provided = Buffer.from(signature, 'hex');
    return crypto.timingSafeEqual(expected, provided) ? id : null;
  };
  const establishSession = (req, res, userId) => {
    const id = crypto.randomBytes(32).toString('hex');
    const csrfToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + SESSION_DAYS * 86400000;
    db.prepare('INSERT INTO sessions (id, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)')
      .run(id, userId, csrfToken, expiresAt);
    setSessionCookie(res, `${id}.${signatureFor(id)}`, SESSION_DAYS * 86400);
    req.session = { id, userId, csrfToken };
  };

  app.use((req, res, next) => {
    const id = readCookie(req);
    if (id) {
      const session = db.prepare(`
        SELECT sessions.id, sessions.user_id, sessions.csrf_token, users.id AS account_id,
          users.full_name, users.email, users.role
        FROM sessions JOIN users ON users.id = sessions.user_id
        WHERE sessions.id = ? AND sessions.expires_at > ?
      `).get(id, Date.now());
      if (session) {
        req.session = { id: session.id, userId: session.user_id, csrfToken: session.csrf_token };
        req.user = safeUser({ id: session.account_id, full_name: session.full_name, email: session.email, role: session.role });
      } else {
        db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      }
    }
    next();
  });

  const requireAuth = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Please sign in to continue.' });
    next();
  };
  const requireRole = (role) => (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Please sign in to continue.' });
    if (req.user.role !== role) return res.status(403).json({ error: 'You do not have permission to do that.' });
    next();
  };
  const requireCsrf = (req, res, next) => {
    const origin = req.get('origin');
    if (origin) {
      try {
        if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Request origin could not be verified.' });
      } catch {
        return res.status(403).json({ error: 'Request origin could not be verified.' });
      }
    }
    const supplied = req.get('x-csrf-token') || '';
    if (!req.session || supplied.length !== req.session.csrfToken.length
      || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(req.session.csrfToken))) {
      return res.status(403).json({ error: 'Your security token has expired. Refresh the page and try again.' });
    }
    next();
  };
  const requireAdmin = [requireRole('admin'), requireCsrf];
  const requireStudent = [requireRole('student'), requireCsrf];
  const rateLimit = (keyPrefix, limit) => (req, res, next) => {
    const now = Date.now();
    const key = `${keyPrefix}:${req.ip}`;
    const entry = loginAttempts.get(key);
    if (!entry || entry.expiresAt <= now) {
      loginAttempts.set(key, { count: 1, expiresAt: now + 15 * 60 * 1000 });
      return next();
    }
    entry.count += 1;
    if (entry.count > limit) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
    next();
  };
  setInterval(() => {
    const now = Date.now();
    for (const [key, value] of loginAttempts) if (value.expiresAt <= now) loginAttempts.delete(key);
  }, 5 * 60 * 1000).unref();
  setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now()), 60 * 60 * 1000).unref();

  const sendError = (res, status, message) => res.status(status).json({ error: message });
  const validString = (value, min, max) => typeof value === 'string' && value.trim().length >= min && value.trim().length <= max;
  const checkOrigin = (req, res) => {
    const origin = req.get('origin');
    if (!origin) return true;
    try {
      if (new URL(origin).host === req.get('host')) return true;
    } catch {}
    sendError(res, 403, 'Request origin could not be verified.');
    return false;
  };

  app.get('/api/health', (req, res) => res.json({ status: 'ok', application: 'CampusFix' }));
  app.get('/api/auth/me', (req, res) => res.json({ user: req.user || null, csrfToken: req.session ? req.session.csrfToken : null }));
  app.post('/api/auth/register', rateLimit('register', 5), (req, res) => {
    if (!checkOrigin(req, res)) return;
    const { name, email, password } = req.body || {};
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!validString(name, 2, 70)) return sendError(res, 400, 'Please enter a name between 2 and 70 characters.');
    if (normalizedEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) return sendError(res, 400, 'Please enter a valid email address.');
    if (typeof password !== 'string' || password.length < 10 || password.length > 128) return sendError(res, 400, 'Your password must be between 10 and 128 characters.');
    try {
      const result = db.prepare('INSERT INTO users (full_name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(name.trim(), normalizedEmail, hashPassword(password), 'student', new Date().toISOString());
      establishSession(req, res, result.lastInsertRowid);
      req.user = safeUser({ id: result.lastInsertRowid, full_name: name.trim(), email: normalizedEmail, role: 'student' });
      loginAttempts.delete(`register:${req.ip}`);
      res.status(201).json({ user: req.user, csrfToken: req.session.csrfToken });
    } catch (error) {
      if (error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/i.test(error.message)) return sendError(res, 409, 'An account with that email already exists.');
      throw error;
    }
  });
  app.post('/api/auth/login', rateLimit('login', 8), (req, res) => {
    if (!checkOrigin(req, res)) return;
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string' || email.length > 254 || password.length > 128) {
      return sendError(res, 400, 'Enter your email and password.');
    }
    const user = db.prepare('SELECT id, full_name, email, role, password_hash FROM users WHERE email = ? COLLATE NOCASE').get(email.trim());
    const passwordMatches = verifyPassword(password, user ? user.password_hash : dummyPasswordHash);
    if (!user || !passwordMatches) return sendError(res, 401, 'That email and password do not match.');
    loginAttempts.delete(`login:${req.ip}`);
    establishSession(req, res, user.id);
    req.user = safeUser(user);
    res.json({ user: req.user, csrfToken: req.session.csrfToken });
  });
  app.post('/api/auth/logout', requireAuth, requireCsrf, (req, res) => {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(req.session.id);
    setSessionCookie(res, '', 0);
    res.json({ success: true });
  });

  const complaintSelect = `
    SELECT complaints.id, complaints.student_id AS studentId, complaints.title, complaints.description,
      complaints.category, complaints.location, complaints.status, complaints.priority,
      complaints.admin_response AS adminResponse, complaints.image_name AS imageName,
      complaints.created_at AS createdAt, complaints.updated_at AS updatedAt,
      users.full_name AS studentName, users.email AS studentEmail
    FROM complaints JOIN users ON users.id = complaints.student_id
  `;
  const serializeComplaint = (row) => ({
    id: row.id,
    reference: `CF-${String(row.id).padStart(4, '0')}`,
    studentId: row.studentId,
    studentName: row.studentName,
    studentEmail: row.studentEmail,
    title: row.title,
    description: row.description,
    category: row.category,
    location: row.location,
    status: row.status,
    priority: row.priority,
    adminResponse: row.adminResponse,
    imageUrl: row.imageName ? `/api/complaints/${row.id}/image` : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  const checkComplaintOwner = (complaint, req, res) => {
    if (!complaint) {
      sendError(res, 404, 'We could not find that complaint.');
      return false;
    }
    if (req.user.role === 'student' && complaint.studentId !== req.user.id) {
      sendError(res, 404, 'We could not find that complaint.');
      return false;
    }
    return true;
  };
  const findComplaint = (id) => {
    if (!/^\d+$/.test(String(id))) return null;
    return db.prepare(`${complaintSelect} WHERE complaints.id = ?`).get(Number(id));
  };

  app.get('/api/dashboard', requireAuth, (req, res) => {
    const studentClause = req.user.role === 'student' ? 'WHERE student_id = ?' : '';
    const studentArgs = req.user.role === 'student' ? [req.user.id] : [];
    const grouped = db.prepare(`
      SELECT status, COUNT(*) AS count FROM complaints ${studentClause} GROUP BY status
    `).all(...studentArgs);
    const statusCounts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
    for (const row of grouped) statusCounts[row.status] = row.count;
    const categoryRows = db.prepare(`
      SELECT category, COUNT(*) AS count FROM complaints ${studentClause} GROUP BY category ORDER BY count DESC, category ASC
    `).all(...studentArgs);
    const total = Object.values(statusCounts).reduce((sum, count) => sum + count, 0);
    const unread = db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND read_at IS NULL').get(req.user.id).count;
    res.json({ stats: { total, active: statusCounts['In Progress'] + statusCounts['Under Review'], resolved: statusCounts.Resolved, submitted: statusCounts.Submitted, unread }, statusCounts, categories: categoryRows });
  });

  app.get('/api/complaints', requireAuth, (req, res) => {
    const clauses = [];
    const args = [];
    if (req.user.role === 'student') {
      clauses.push('complaints.student_id = ?');
      args.push(req.user.id);
    }
    for (const [parameter, column, values] of [
      ['status', 'complaints.status', STATUSES],
      ['category', 'complaints.category', CATEGORIES],
      ['priority', 'complaints.priority', PRIORITIES],
    ]) {
      if (req.query[parameter]) {
        if (!values.includes(req.query[parameter])) return sendError(res, 400, `Invalid ${parameter} filter.`);
        clauses.push(`${column} = ?`);
        args.push(req.query[parameter]);
      }
    }
    if (req.query.q) {
      if (typeof req.query.q !== 'string' || req.query.q.length > 100) return sendError(res, 400, 'Search must be 100 characters or fewer.');
      const pattern = `%${req.query.q.trim().replace(/[\\%_]/g, '\\$&')}%`;
      clauses.push("(complaints.title LIKE ? ESCAPE '\\' OR complaints.location LIKE ? ESCAPE '\\' OR users.full_name LIKE ? ESCAPE '\\' OR complaints.category LIKE ? ESCAPE '\\')");
      args.push(pattern, pattern, pattern, pattern);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`${complaintSelect} ${where} ORDER BY complaints.created_at DESC LIMIT 200`).all(...args);
    res.json({ complaints: rows.map(serializeComplaint) });
  });

  app.post('/api/complaints', requireStudent, (req, res) => {
    const { title, description, category, location, imageData } = req.body || {};
    if (!validString(title, 5, 120)) return sendError(res, 400, 'Give your complaint a title between 5 and 120 characters.');
    if (!validString(description, 15, 2500)) return sendError(res, 400, 'Add a description between 15 and 2,500 characters.');
    if (!validString(location, 2, 120)) return sendError(res, 400, 'Enter a location between 2 and 120 characters.');
    if (!CATEGORIES.includes(category)) return sendError(res, 400, 'Choose one of the listed complaint categories.');
    let imageName = null;
    if (imageData) {
      if (typeof imageData.data !== 'string' || typeof imageData.type !== 'string' || !IMAGE_TYPES[imageData.type]) {
        return sendError(res, 400, 'Use a JPEG, PNG or WebP photo.');
      }
      const encoded = imageData.data.replace(/^data:image\/(?:jpeg|png|webp);base64,/, '');
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) return sendError(res, 400, 'The uploaded photo could not be read.');
      const image = Buffer.from(encoded, 'base64');
      const metadata = IMAGE_TYPES[imageData.type];
      if (image.length > MAX_IMAGE_BYTES) return sendError(res, 413, 'Photos must be 3 MB or smaller.');
      if (!image.length || !metadata.signature(image)) return sendError(res, 400, 'The photo contents do not match the selected image type.');
      imageName = `${crypto.randomBytes(24).toString('hex')}${metadata.extension}`;
      fs.writeFileSync(path.join(uploadDir, imageName), image, { flag: 'wx' });
    }
    const createdAt = new Date().toISOString();
    const insertComplaint = db.prepare(`
      INSERT INTO complaints (student_id, title, description, category, location, image_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertHistory = db.prepare(`
      INSERT INTO complaint_history (complaint_id, old_status, new_status, note, changed_by, changed_at)
      VALUES (?, NULL, 'Submitted', ?, ?, ?)
    `);
    db.exec('BEGIN');
    try {
      const result = insertComplaint.run(req.user.id, title.trim(), description.trim(), category, location.trim(), imageName, createdAt, createdAt);
      insertHistory.run(result.lastInsertRowid, 'Complaint submitted by the student.', req.user.id, createdAt);
      db.exec('COMMIT');
      res.status(201).json({ complaint: serializeComplaint(findComplaint(result.lastInsertRowid)) });
    } catch (error) {
      db.exec('ROLLBACK');
      if (imageName) fs.unlinkSync(path.join(uploadDir, imageName));
      throw error;
    }
  });

  app.get('/api/complaints/:id', requireAuth, (req, res) => {
    const row = findComplaint(req.params.id);
    if (!checkComplaintOwner(row, req, res)) return;
    const history = db.prepare(`
      SELECT complaint_history.id, complaint_history.old_status AS oldStatus,
        complaint_history.new_status AS newStatus, complaint_history.note,
        complaint_history.changed_at AS changedAt, users.full_name AS changedBy
      FROM complaint_history JOIN users ON users.id = complaint_history.changed_by
      WHERE complaint_history.complaint_id = ? ORDER BY complaint_history.changed_at ASC, complaint_history.id ASC
    `).all(row.id);
    res.json({ complaint: serializeComplaint(row), history });
  });

  app.get('/api/complaints/:id/image', requireAuth, (req, res) => {
    const row = findComplaint(req.params.id);
    if (!checkComplaintOwner(row, req, res)) return;
    if (!row.imageName) return sendError(res, 404, 'This complaint does not have a photo.');
    const filePath = path.join(uploadDir, row.imageName);
    if (!fs.existsSync(filePath)) return sendError(res, 404, 'This photo is no longer available.');
    res.set({ 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
    res.type(path.extname(row.imageName)).sendFile(filePath);
  });

  app.patch('/api/complaints/:id', requireAdmin, (req, res) => {
    const row = findComplaint(req.params.id);
    if (!row) return sendError(res, 404, 'We could not find that complaint.');
    const { status, priority, response } = req.body || {};
    const updates = [];
    const args = [];
    if (status !== undefined) {
      if (!STATUSES.includes(status)) return sendError(res, 400, 'Choose a valid complaint status.');
      if (status !== row.status && !ALLOWED_TRANSITIONS[row.status].includes(status)) {
        return sendError(res, 400, `A complaint marked “${row.status}” cannot move directly to “${status}”.`);
      }
      if (status !== row.status) {
        updates.push('status = ?');
        args.push(status);
      }
    }
    if (priority !== undefined) {
      if (!PRIORITIES.includes(priority)) return sendError(res, 400, 'Choose a valid priority.');
      if (priority !== row.priority) {
        updates.push('priority = ?');
        args.push(priority);
      }
    }
    if (response !== undefined) {
      if (typeof response !== 'string' || response.trim().length > 1000) return sendError(res, 400, 'Responses must be 1,000 characters or fewer.');
      if (response.trim() !== row.adminResponse) {
        updates.push('admin_response = ?');
        args.push(response.trim());
      }
    }
    if (!updates.length) return sendError(res, 400, 'There are no changes to save.');

    const changedAt = new Date().toISOString();
    const newStatus = status === undefined ? row.status : status;
    const newResponse = response === undefined ? row.adminResponse : response.trim();
    const details = [];
    if (status && status !== row.status) details.push(`Status changed to ${status}.`);
    if (priority && priority !== row.priority) details.push(`Priority set to ${priority}.`);
    if (response !== undefined && newResponse !== row.adminResponse && newResponse) details.push(newResponse);

    db.exec('BEGIN');
    try {
      updates.push('updated_at = ?');
      args.push(changedAt, row.id);
      db.prepare(`UPDATE complaints SET ${updates.join(', ')} WHERE id = ?`).run(...args);
      if (status && status !== row.status) {
        db.prepare(`
          INSERT INTO complaint_history (complaint_id, old_status, new_status, note, changed_by, changed_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(row.id, row.status, status, newResponse || details.join(' '), req.user.id, changedAt);
      }
      if ((status && status !== row.status) || (response !== undefined && newResponse !== row.adminResponse && newResponse)) {
        const message = status && status !== row.status
          ? `Your complaint “${row.title}” is now ${newStatus}.${newResponse ? ` ${newResponse}` : ''}`
          : `A campus administrator replied to “${row.title}”: ${newResponse}`;
        db.prepare('INSERT INTO notifications (user_id, complaint_id, message, created_at) VALUES (?, ?, ?, ?)')
          .run(row.studentId, row.id, message, changedAt);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    res.json({ complaint: serializeComplaint(findComplaint(row.id)) });
  });

  app.get('/api/notifications', requireAuth, (req, res) => {
    const notifications = db.prepare(`
      SELECT notifications.id, notifications.complaint_id AS complaintId,
        complaints.title AS complaintTitle, notifications.message, notifications.read_at AS readAt,
        notifications.created_at AS createdAt
      FROM notifications JOIN complaints ON complaints.id = notifications.complaint_id
      WHERE notifications.user_id = ? ORDER BY notifications.created_at DESC LIMIT 50
    `).all(req.user.id);
    res.json({ notifications });
  });
  app.patch('/api/notifications/read', requireAuth, requireCsrf, (req, res) => {
    const result = db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL')
      .run(new Date().toISOString(), req.user.id);
    res.json({ updated: result.changes });
  });

  app.use('/api', (req, res) => sendError(res, 404, 'That CampusFix endpoint does not exist.'));
  app.use(express.static(path.join(__dirname, 'public'), {
    etag: true,
    maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
    setHeaders(res, filePath) {
      if (path.basename(filePath) === 'index.html') res.setHeader('Cache-Control', 'no-store');
    },
  }));
  app.get('*splat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.too.large') return sendError(res, 413, 'This request is too large. Photos must be 3 MB or smaller.');
    if (error instanceof SyntaxError && 'body' in error) return sendError(res, 400, 'Please check the request and try again.');
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.path}`, error);
    sendError(res, 500, 'Something went wrong. Please try again.');
  });

  app.locals.db = db;
  app.locals.uploadDir = uploadDir;
  app.locals.close = () => db.close();
  return app;
}

if (require.main === module) {
  const app = createApp();
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '127.0.0.1';
  const server = app.listen(port, host, () => {
    console.log(`CampusFix is running at http://${host}:${port}`);
    console.log('Demo student: student@campusfix.edu / CampusFixStudent!2026');
    console.log('Demo admin:   admin@campusfix.edu / CampusFixAdmin!2026');
  });
  const shutdown = () => server.close(() => {
    app.locals.close();
    process.exit(0);
  });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createApp, CATEGORIES, STATUSES, PRIORITIES, hashPassword, verifyPassword };
