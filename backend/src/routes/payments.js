const express = require('express');
const crypto = require('crypto');
const db = require('../config/db');
const { requireAuth, requireMajorAdmin, getCommitteeGameId } = require('../middleware/auth');
const { resolveEntityId } = require('../utils/resolveEntityId');

const router = express.Router();

function makeAttendanceToken() {
  return crypto.randomBytes(12).toString('hex');
}

function formatSessionDate(sessionDate) {
  if (sessionDate instanceof Date) return sessionDate.toISOString().slice(0, 10);
  return String(sessionDate);
}

function getSessionDateTime(sessionDate, timeStr) {
  const datePart = formatSessionDate(sessionDate);
  return new Date(`${datePart}T${timeStr}`);
}

function getSessionState(session) {
  const now = new Date();
  const start = getSessionDateTime(session.session_date, session.start_time);
  const end = getSessionDateTime(session.session_date, session.end_time);
  if (now < start) return 'upcoming';
  if (now > end) return 'past';
  return 'active';
}

function serializeAttendanceSession(session) {
  return {
    ...session,
    state: getSessionState(session),
    start_at: `${formatSessionDate(session.session_date)} ${session.start_time}`,
    end_at: `${formatSessionDate(session.session_date)} ${session.end_time}`
  };
}

router.get('/rates', requireAuth, async (req, res) => {
  try {
    const [rates] = await db.query('SELECT * FROM payment_rates ORDER BY role');
    res.json({ rates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/rates', requireMajorAdmin, async (req, res) => {
  const { role, unit_type, amount } = req.body;
  if (!role || !unit_type || amount == null) {
    return res.status(400).json({ error: 'role, unit_type and amount are required.' });
  }
  try {
    await db.query(
      `INSERT INTO payment_rates (role, unit_type, amount)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE unit_type = VALUES(unit_type), amount = VALUES(amount)`,
      [role, unit_type, amount]
    );
    res.status(201).json({ message: 'Payment rate saved.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/calculate', requireAuth, async (req, res) => {
  const { game_id, include_shifts, include_matches } = req.body;
  try {
    let resolvedGameId = null;
    if (game_id) {
      resolvedGameId = await resolveEntityId('games', game_id, ['name', 'sport_type']);
      if (!resolvedGameId) return res.status(404).json({ error: 'Game not found.' });
    }

    if (req.user.role !== 'Major_Admin' && req.user.role !== 'Committee_Member') {
      return res.status(403).json({ error: 'Not authorized.' });
    }
    if (req.user.role === 'Committee_Member') {
      const gid = await getCommitteeGameId(req.user.id);
      if (!gid || (resolvedGameId && Number(gid) !== Number(resolvedGameId))) {
        return res.status(403).json({ error: 'Not authorized for this game.' });
      }
    }

    const [rates] = await db.query('SELECT role, unit_type, amount FROM payment_rates');
    const rateMap = rates.reduce((acc, item) => ({ ...acc, [item.role]: item }), {});

    const payments = [];
    if (include_matches !== false) {
      const [officials] = await db.query(
        `SELECT mo.id, mo.volunteer_id, mo.role, mo.match_id, mo.assigned_at,
                v.full_name, v.email, m.status AS match_status
         FROM match_officials mo
         JOIN volunteers v ON v.id = mo.volunteer_id
         JOIN matches m ON m.id = mo.match_id
         WHERE m.status = 'completed'${resolvedGameId ? ' AND m.game_id = ?' : ''}`,
        resolvedGameId ? [resolvedGameId] : []
      );

      for (const official of officials) {
        const rate = rateMap[official.role];
        if (!rate) continue;
        payments.push({
          volunteer_id: official.volunteer_id,
          full_name: official.full_name,
          email: official.email,
          role: official.role,
          source: 'match',
          source_id: official.match_id,
          amount: Number(rate.amount || 0).toFixed(2)
        });
      }
    }

    if (include_shifts !== false) {
      const [shifts] = await db.query(
        `SELECT vs.id, vs.volunteer_id, vs.duration_minutes, v.full_name, v.email, vs.status
         FROM volunteer_shifts vs
         JOIN volunteers v ON v.id = vs.volunteer_id
         WHERE vs.status = 'completed'${resolvedGameId ? ' AND vs.game_id = ?' : ''}`,
        resolvedGameId ? [resolvedGameId] : []
      );

      for (const shift of shifts) {
        const rate = rateMap.volunteer;
        if (!rate) continue;
        payments.push({
          volunteer_id: shift.volunteer_id,
          full_name: shift.full_name,
          email: shift.email,
          role: 'volunteer',
          source: 'shift',
          source_id: shift.id,
          amount: Number(rate.amount || 0).toFixed(2)
        });
      }
    }

    res.json({ payments, total: payments.reduce((sum, p) => sum + Number(p.amount), 0).toFixed(2) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/stage', requireMajorAdmin, async (req, res) => {
  const { payments } = req.body;
  if (!Array.isArray(payments) || payments.length === 0) {
    return res.status(400).json({ error: 'payments array is required.' });
  }
  try {
    const tasks = payments.map((p) => db.query(
      `INSERT INTO payments (volunteer_id, shift_id, role, source_type, amount, status, processed_by, processed_at)
       VALUES (?, ?, ?, ?, ?, 'staged', ?, NOW())`,
      [p.volunteer_id, p.shift_id || null, p.role, p.source, p.amount, req.user.id]
    ));
    await Promise.all(tasks);
    res.status(201).json({ message: 'Payments staged for approval.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/', requireMajorAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT p.*, v.full_name AS volunteer_name, v.email, g.name AS game_name, vs.shift_start, vs.shift_end
       FROM payments p
       JOIN volunteers v ON v.id = p.volunteer_id
       LEFT JOIN volunteer_shifts vs ON vs.id = p.shift_id
       LEFT JOIN games g ON g.id = vs.game_id
       ORDER BY p.created_at DESC`
    );
    res.json({ payments: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id', requireMajorAdmin, async (req, res) => {
  const { status } = req.body;
  if (!['pending', 'staged', 'paid', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Invalid payment status.' });
  }
  try {
    await db.query('UPDATE payments SET status = ?, processed_by = ?, processed_at = NOW() WHERE id = ?', [status, req.user.id, req.params.id]);
    res.json({ message: 'Payment record updated.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/attendance-sessions', requireMajorAdmin, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM attendance_sessions ORDER BY session_date DESC, start_time DESC');
    res.json({ sessions: rows.map(serializeAttendanceSession) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/attendance-sessions', requireMajorAdmin, async (req, res) => {
  const { title, session_date, start_time, end_time, details } = req.body;
  if (!title || !session_date || !start_time || !end_time) {
    return res.status(400).json({ error: 'title, session_date, start_time and end_time are required.' });
  }
  const start = getSessionDateTime(session_date, start_time);
  const end = getSessionDateTime(session_date, end_time);
  if (end <= start) {
    return res.status(400).json({ error: 'end_time must be after start_time.' });
  }
  try {
    const createdBy = Number(req.user.id) > 0 ? req.user.id : null;
    const [result] = await db.query(
      `INSERT INTO attendance_sessions (title, session_date, start_time, end_time, details, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [title, session_date, start_time, end_time, details || null, createdBy]
    );
    res.status(201).json({ id: result.insertId, message: 'Attendance session created.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/attendance-sessions/active', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT * FROM attendance_sessions ORDER BY session_date DESC, start_time DESC`
    );
    const sessions = rows.map(serializeAttendanceSession);
    const activeSession = sessions.find((session) => session.state === 'active');
    if (activeSession) {
      return res.json({ session: activeSession });
    }

    const upcomingSession = sessions
      .filter((session) => session.state === 'upcoming')
      .sort((a, b) => new Date(`${a.session_date}T${a.start_time}`) - new Date(`${b.session_date}T${b.start_time}`))[0];

    if (upcomingSession) {
      return res.json({ session: upcomingSession });
    }

    res.json({ session: null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/attendance-sessions/:id', requireMajorAdmin, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM attendance_sessions WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Attendance session not found.' });
    res.json({ session: serializeAttendanceSession(rows[0]) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/attendance-sessions/:id/attendance', requireMajorAdmin, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM attendance_sessions WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Attendance session not found.' });
    const session = rows[0];
    const [students] = await db.query(
      `SELECT u.id, u.full_name, u.username, u.email,
              COALESCE(pa.status, 'absent') AS status,
              pa.scanned_at
       FROM users u
       LEFT JOIN player_attendance pa ON pa.user_id = u.id AND pa.session_id = ?
       WHERE u.role = 'Student'
       ORDER BY u.full_name`,
      [session.id]
    );
    res.json({ session: serializeAttendanceSession(session), attendance: students });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/attendance-sessions/:id/current-token', requireMajorAdmin, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM attendance_sessions WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Attendance session not found.' });
    const session = rows[0];
    if (getSessionState(session) !== 'active') {
      return res.status(400).json({ error: 'QR code is only available during the scheduled session window.' });
    }
    const token = makeAttendanceToken();
    const now = new Date();
    const validTo = new Date(now.getTime() + 10000);
    await db.query(
      'UPDATE attendance_sessions SET current_token = ?, token_valid_from = ?, token_valid_to = ? WHERE id = ?',
      [token, now, validTo, session.id]
    );
    res.json({ token, valid_to: validTo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/attendance-scan', requireAuth, async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token is required.' });
  if (req.user.role !== 'Student') {
    return res.status(403).json({ error: 'Only normal student users may scan attendance.' });
  }

  try {
    const [rows] = await db.query('SELECT * FROM attendance_sessions WHERE current_token = ?', [token]);
    if (!rows.length) return res.status(400).json({ error: 'Invalid or expired QR code.' });
    const session = rows[0];
    const now = new Date();
    const validFrom = new Date(session.token_valid_from);
    const validTo = new Date(session.token_valid_to);
    if (now < validFrom || now > validTo) {
      return res.status(400).json({ error: 'QR code has expired. Please scan the latest code shown by the admin.' });
    }
    const start = getSessionDateTime(session.session_date, session.start_time);
    const end = getSessionDateTime(session.session_date, session.end_time);
    if (now < start || now > end) {
      return res.status(400).json({ error: 'Attendance scanning is only available during the staged session window.' });
    }

    const [existing] = await db.query(
      'SELECT id, status FROM player_attendance WHERE session_id = ? AND user_id = ?',
      [session.id, req.user.id]
    );
    let shouldNotify = false;
    if (existing.length) {
      if (existing[0].status !== 'present') {
        shouldNotify = true;
      }
      await db.query(
        'UPDATE player_attendance SET status = ?, scanned_at = NOW(), scanned_by = ?, updated_at = NOW() WHERE id = ?',
        ['present', req.user.id, existing[0].id]
      );
    } else {
      shouldNotify = true;
      await db.query(
        `INSERT INTO player_attendance (session_id, user_id, status, scanned_at, scanned_by)
         VALUES (?, ?, 'present', NOW(), ?)`,
        [session.id, req.user.id, req.user.id]
      );
    }

    if (shouldNotify) {
      await notifyUser(
        req.user.id,
        'Attendance confirmed',
        `Your attendance for “${session.title}” has been recorded successfully.`,
        'general',
        session.id
      );
    }

    res.json({ message: 'Attendance marked present.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
