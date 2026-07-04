import React, { useEffect, useState } from 'react';
import qrcode from 'qrcode';
import Layout from '../components/Layout';
import PageHeader from '../components/ui/PageHeader';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { DollarSign, Calendar, Users } from 'lucide-react';

const Payments = () => {
  const { user } = useAuth();
  const [attendanceSessions, setAttendanceSessions] = useState([]);
  const [selectedSessionId, setSelectedSessionId] = useState(null);
  const [selectedSession, setSelectedSession] = useState(null);
  const [attendanceSheet, setAttendanceSheet] = useState([]);
  const [sheetUpdatedAt, setSheetUpdatedAt] = useState(null);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState('');
  const [qrToken, setQrToken] = useState('');
  const [attendanceAmount, setAttendanceAmount] = useState(0);
  const [payoutMessage, setPayoutMessage] = useState({ type: '', text: '' });

  const getDefaultSessionValues = () => {
    const now = new Date();
    const defaultDate = now.toISOString().slice(0, 10);
    const minValue = 7 * 60 + 30;
    const maxValue = 14 * 60;
    const formatTime = (totalMinutes) => {
      const h = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
      const m = String(totalMinutes % 60).padStart(2, '0');
      return `${h}:${m}`;
    };

    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    let startMinutes = currentMinutes;
    if (startMinutes < minValue) startMinutes = minValue;
    if (startMinutes > maxValue - 60) startMinutes = maxValue - 60;
    const endMinutes = Math.min(startMinutes + 60, maxValue);

    return {
      title: '',
      session_date: defaultDate,
      start_time: formatTime(startMinutes),
      end_time: formatTime(endMinutes),
      details: '',
    };
  };

  const formatDisplayDate = (value) => {
    if (!value) return '';
    const dateValue = new Date(value);
    if (!isNaN(dateValue.getTime())) {
      return dateValue.toISOString().slice(0, 10);
    }
    return String(value).slice(0, 10);
  };
  const [sessionForm, setSessionForm] = useState(getDefaultSessionValues());
  const [message, setMessage] = useState({ type: '', text: '' });
  const [attendanceMsg, setAttendanceMsg] = useState({ type: '', text: '' });

  const loadAttendanceSessions = async () => {
    try {
      const res = await api.get('/payments/attendance-sessions');
      setAttendanceSessions(res.data.sessions || []);
      if (!selectedSessionId && res.data.sessions?.length) {
        setSelectedSessionId(res.data.sessions[0].id);
      }
    } catch {
      /* ignore attendance session load errors */
    }
  };

  const loadSelectedSession = async (sessionId) => {
    if (!sessionId) {
      setSelectedSession(null);
      setAttendanceSheet([]);
      setQrCodeDataUrl('');
      setQrToken('');
      setSheetUpdatedAt(null);
      return;
    }
    try {
      const [sessionRes, attendanceRes] = await Promise.all([
        api.get(`/payments/attendance-sessions/${sessionId}`, { params: { t: Date.now() } }),
        api.get(`/payments/attendance-sessions/${sessionId}/attendance`, { params: { t: Date.now() } }).catch(() => ({ data: { attendance: [] } }))
      ]);
      setSelectedSession(sessionRes.data.session);
      setAttendanceSheet(attendanceRes.data.attendance || []);
      setSheetUpdatedAt(new Date().toISOString());
    } catch (err) {
      setAttendanceMsg({ type: 'danger', text: err.response?.data?.error || 'Could not load attendance session.' });
    }
  };

  const load = async () => {
    try {
      await loadAttendanceSessions();
    } catch (err) {
      setMessage({ type: 'danger', text: err.response?.data?.error || 'Could not load attendance sessions.' });
    }
  };

  useEffect(() => { load(); }, [user]);

  useEffect(() => {
    if (!selectedSessionId) return;
    loadSelectedSession(selectedSessionId);
  }, [selectedSessionId]);

  useEffect(() => {
    if (!selectedSessionId) return undefined;
    const refresh = setInterval(() => loadSelectedSession(selectedSessionId), 3000);
    return () => clearInterval(refresh);
  }, [selectedSessionId]);

  useEffect(() => {
    if (!selectedSession) return undefined;
    if (selectedSession.state !== 'active') {
      setQrCodeDataUrl('');
      setQrToken('');
      return undefined;
    }

    let interval;
    const refreshToken = async () => {
      try {
        const res = await api.get(`/payments/attendance-sessions/${selectedSession.id}/current-token`);
        setQrToken(res.data.token);
        const qrcodeUrl = await qrcode.toDataURL(res.data.token);
        setQrCodeDataUrl(qrcodeUrl);
      } catch (err) {
        setAttendanceMsg({ type: 'danger', text: err.response?.data?.error || 'Failed to refresh QR token.' });
      }
    };

    refreshToken();
    interval = setInterval(refreshToken, 5000);
    return () => clearInterval(interval);
  }, [selectedSession]);

  const calculateAttendancePayout = async (e) => {
    e.preventDefault();
    const amount = Number(attendanceAmount || 0);
    const presentCount = attendanceSheet.filter((row) => row.status === 'present').length;
    if (!selectedSession) {
      setPayoutMessage({ type: 'danger', text: 'Select an attendance session first.' });
      return;
    }
    if (amount <= 0) {
      setPayoutMessage({ type: 'danger', text: 'Enter a valid amount to distribute.' });
      return;
    }
    setPayoutMessage({
      type: 'success',
      text: `Calculated payout for ${presentCount} present student(s): ₹${(amount * presentCount).toFixed(2)}.`
    });
  };

  const createAttendanceSession = async (e) => {
    e.preventDefault();
    setAttendanceMsg({ type: '', text: '' });
    try {
      const res = await api.post('/payments/attendance-sessions', sessionForm);
      const newSessionId = res.data.id;
      setAttendanceMsg({ type: 'success', text: 'Attendance session created.' });
      setSessionForm(getDefaultSessionValues());
      await loadAttendanceSessions();
      if (newSessionId) {
        setSelectedSessionId(newSessionId);
      }
    } catch (err) {
      setAttendanceMsg({ type: 'danger', text: err.response?.data?.error || 'Could not create attendance session.' });
    }
  };

  const selectSession = async (sessionId) => {
    setSelectedSessionId(sessionId);
    await loadSelectedSession(sessionId);
  };

  return (
    <Layout>
      <div className="oswms-container oswms-page">
        <PageHeader
          eyebrow="Automated payments"
          title="Payments & payouts"
          subtitle="Create attendance sessions and distribute amounts for present students."
          badge={<span className="badge bg-warning text-dark">{user?.role === 'Major_Admin' ? 'Major Admin' : 'Committee'}</span>}
        />

        {message.text && <div className={`alert alert-${message.type}`}>{message.text}</div>}
        {attendanceMsg.text && <div className={`alert alert-${attendanceMsg.type}`}>{attendanceMsg.text}</div>}

        <div className="row g-4">
          <div className="col-lg-12">
            <div className="oswms-card p-4">
              <h2 className="h5 mb-3"><DollarSign size={18} /> Attendance payout</h2>
              <form onSubmit={calculateAttendancePayout}>
                <div className="row g-3 align-items-end">
                  <div className="col-md-4">
                    <label className="form-label">Amount per present student</label>
                    <input
                      type="number"
                      min="0"
                      step="0.5"
                      className="form-control"
                      value={attendanceAmount}
                      onChange={(e) => setAttendanceAmount(Number(e.target.value))}
                    />
                  </div>
                  <div className="col-md-4">
                    <label className="form-label">Present students</label>
                    <input
                      type="text"
                      readOnly
                      className="form-control"
                      value={attendanceSheet.filter((row) => row.status === 'present').length}
                    />
                  </div>
                  <div className="col-md-4">
                    <label className="form-label">Total payout</label>
                    <input
                      type="text"
                      readOnly
                      className="form-control"
                      value={`₹${(attendanceAmount * attendanceSheet.filter((row) => row.status === 'present').length).toFixed(2)}`}
                    />
                  </div>
                </div>
                <div className="row g-3 mt-3">
                  <div className="col-auto">
                    <button type="submit" className="btn btn-oswms-primary">Calculate payout</button>
                  </div>
                  {payoutMessage.text && (
                    <div className={`col alert alert-${payoutMessage.type} mb-0 py-2`} role="alert">
                      {payoutMessage.text}
                    </div>
                  )}
                </div>
              </form>
            </div>
          </div>
        </div>

        <div className="row g-4 mt-4">
          <div className="col-lg-5">
            <div className="oswms-card p-4 h-100">
              <h2 className="h5 mb-3"><Calendar size={18} /> Attendance session</h2>
              <form onSubmit={createAttendanceSession}>
                <div className="mb-3">
                  <label className="form-label">Title</label>
                  <input
                    className="form-control"
                    required
                    value={sessionForm.title}
                    onChange={(e) => setSessionForm({ ...sessionForm, title: e.target.value })}
                  />
                </div>
                <div className="row g-3 mb-3">
                  <div className="col-6">
                    <label className="form-label">Date</label>
                    <input
                      type="date"
                      className="form-control"
                      required
                      value={sessionForm.session_date}
                      onChange={(e) => setSessionForm({ ...sessionForm, session_date: e.target.value })}
                    />
                  </div>
                  <div className="col-3">
                    <label className="form-label">Starts</label>
                    <input
                      type="time"
                      className="form-control"
                      required
                      value={sessionForm.start_time}
                      onChange={(e) => setSessionForm({ ...sessionForm, start_time: e.target.value })}
                    />
                  </div>
                  <div className="col-3">
                    <label className="form-label">Ends</label>
                    <input
                      type="time"
                      className="form-control"
                      required
                      value={sessionForm.end_time}
                      onChange={(e) => setSessionForm({ ...sessionForm, end_time: e.target.value })}
                    />
                  </div>
                </div>
                <div className="mb-3">
                  <label className="form-label">Details</label>
                  <textarea
                    className="form-control"
                    rows="3"
                    value={sessionForm.details}
                    onChange={(e) => setSessionForm({ ...sessionForm, details: e.target.value })}
                  />
                </div>
                <button type="submit" className="btn btn-oswms-primary w-100">Create session</button>
              </form>
            </div>
          </div>
          <div className="col-lg-7">
            <div className="oswms-card p-4 h-100">
              <div className="d-flex justify-content-between align-items-center mb-3">
                <div>
                  <h2 className="h5 mb-1"><Users size={18} /> Attendance sessions</h2>
                  <p className="small text-muted mb-0">Select a session to view QR code or attendance status.</p>
                </div>
              </div>
              <div className="table-responsive">
                <table className="table oswms-table table-hover mb-0">
                  <thead>
                    <tr>
                      <th>Title</th>
                      <th>Date</th>
                      <th>Time</th>
                      <th>Status</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {attendanceSessions.length === 0 ? (
                      <tr><td colSpan="5" className="text-muted">No attendance sessions yet.</td></tr>
                    ) : attendanceSessions.map((session) => (
                      <tr key={session.id} className={selectedSessionId === session.id ? 'table-active' : ''}>
                        <td>{session.title}</td>
                        <td>{formatDisplayDate(session.session_date)}</td>
                        <td>{session.start_time} - {session.end_time}</td>
                        <td>{session.state}</td>
                        <td>
                          <button type="button" className="btn btn-sm btn-outline-primary" onClick={() => selectSession(session.id)}>
                            View
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        {selectedSession && (
          <div className="row g-4 mt-4">
            <div className="col-xl-4">
              <div className="oswms-card p-4 h-100">
                <div className="d-flex justify-content-between align-items-start mb-3">
                  <div>
                    <h2 className="h5 mb-1">{selectedSession.title}</h2>
                    <p className="small text-muted mb-1">{selectedSession.start_at} — {selectedSession.end_at}</p>
                    <span className={`badge ${selectedSession.state === 'active' ? 'bg-success' : selectedSession.state === 'upcoming' ? 'bg-info text-dark' : 'bg-secondary'}`}>
                      {selectedSession.state}
                    </span>
                  </div>
                </div>

                {selectedSession.state === 'active' ? (
                  <>
                    <div className="text-center mb-3">
                      {qrCodeDataUrl ? (
                        <img src={qrCodeDataUrl} alt="Attendance QR code" className="img-fluid rounded border" />
                      ) : (
                        <div className="border rounded p-5 text-muted">Loading QR code...</div>
                      )}
                    </div>
                    <div className="bg-light rounded p-3 mb-3">
                      <p className="small mb-1">Active attendance session</p>
                      <p className="small text-muted mb-0">QR rotates every 5 seconds. Only students may scan during the live session.</p>
                    </div>
                    <div className="border rounded p-3">
                      <p className="small mb-1"><strong>Session details</strong></p>
                      <p className="small mb-1">{selectedSession.details || 'No additional details.'}</p>
                    </div>
                  </>
                ) : selectedSession.state === 'upcoming' ? (
                  <div className="alert alert-info mb-0">
                    This session has not started yet. The QR code will appear on the session start time.
                  </div>
                ) : (
                  <div className="alert alert-secondary mb-0">
                    This session is complete. Attendance sheet is below for review.
                  </div>
                )}
              </div>
            </div>
            <div className="col-xl-8">
              <div className="oswms-card p-4 h-100">
                <div className="d-flex justify-content-between align-items-center mb-3">
                  <div>
                    <h2 className="h5 mb-1">Attendance sheet</h2>
                    <p className="small text-muted mb-0">View present / absent status for the selected session.</p>
                  </div>
                  <div className="d-flex align-items-center gap-2">
                    <label className="form-label small mb-0">Session date</label>
                    <select
                      className="form-select form-select-sm"
                      value={selectedSessionId || ''}
                      onChange={(e) => selectSession(Number(e.target.value))}
                    >
                      {attendanceSessions.map((session) => (
                        <option key={session.id} value={session.id}>
                          {formatDisplayDate(session.session_date)} • {session.title}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                {sheetUpdatedAt && (
                  <div className="small text-muted mb-3">Updated: {new Date(sheetUpdatedAt).toLocaleTimeString()}</div>
                )}
                <div className="table-responsive" style={{ maxHeight: '340px', overflowY: 'auto' }}>
                  <table className="table table-sm table-hover mb-0">
                    <thead>
                      <tr>
                        <th>Student</th>
                        <th>Email</th>
                        <th>Status</th>
                        <th>Scanned at</th>
                      </tr>
                    </thead>
                    <tbody>
                      {attendanceSheet.length === 0 ? (
                        <tr><td colSpan="4" className="text-muted">No attendance records available.</td></tr>
                      ) : attendanceSheet.map((row) => (
                        <tr key={row.id}>
                          <td>{row.full_name}</td>
                          <td>{row.email || '-'}</td>
                          <td>
                            <span className={`badge ${row.status === 'present' ? 'bg-success' : 'bg-danger'}`}>
                              {row.status}
                            </span>
                          </td>
                          <td>{row.scanned_at ? new Date(row.scanned_at).toLocaleString() : '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        )}

      </div>
    </Layout>
  );
};

export default Payments;
