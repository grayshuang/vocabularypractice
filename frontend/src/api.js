// 部署到公网/局域网时，前端与后端同源（同一域名/IP:端口），用相对路径调接口；
// 本地开发（Vite :5173）仍连后端 :3000。可用 VITE_API_BASE 环境变量覆盖。
const API_BASE = (import.meta.env.VITE_API_BASE)
  || (window.location.port === '5173' ? 'http://localhost:3000' : '');

async function request(url, options = {}) {
  const token = localStorage.getItem('token');
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${url}`, { ...options, headers });
  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.error || '请求失败');
  }
  return res.json();
}

export default {
  // 通用 POST（用于未封装的接口，如密码重置）
  post: (url, data) => request(url, { method: 'POST', body: JSON.stringify(data) }),
  // 学生
  studentRegister: (data) => request('/api/student/register', { method: 'POST', body: JSON.stringify(data) }),
  studentLogin: (data) => request('/api/student/login', { method: 'POST', body: JSON.stringify(data) }),
  // 教师
  teacherRegister: (data) => request('/api/teacher/register', { method: 'POST', body: JSON.stringify(data) }),
  teacherLogin: (data) => request('/api/teacher/login', { method: 'POST', body: JSON.stringify(data) }),
  // 管理员
  adminLogin: (data) => request('/api/admin/login', { method: 'POST', body: JSON.stringify(data) }),
  // 房间
  createRoom: (data) => request('/api/room/create', { method: 'POST', body: JSON.stringify(data) }),
  getRooms: () => request('/api/teacher/rooms'),
  getRoom: (roomCode) => request(`/api/room/${roomCode}`),
  deleteRoom: (roomCode) => request(`/api/room/${roomCode}`, { method: 'DELETE' }),
  joinRoom: (room_code) => request('/api/room/join', { method: 'POST', body: JSON.stringify({ room_code }) }),
  // 练习题目（支持按模式筛选词汇）
  getQuestions: (room_code, mode_type) => request(`/api/practice/questions?room_code=${encodeURIComponent(room_code)}${mode_type ? '&mode_type=' + encodeURIComponent(mode_type) : ''}`),
  startPractice: (data) => request('/api/practice/start', { method: 'POST', body: JSON.stringify(data) }),
  submitAnswer: (data) => request('/api/practice/answer', { method: 'POST', body: JSON.stringify(data) }),
  finishPractice: (data) => request('/api/practice/finish', { method: 'POST', body: JSON.stringify(data) }),
  // 学生数据
  getHistory: () => request('/api/student/history'),
  saveHistoryNote: (session_id, note) => request('/api/student/history/note', { method: 'POST', body: JSON.stringify({ session_id, note }) }),
  deleteHistory: (session_id) => request('/api/student/history/delete', { method: 'POST', body: JSON.stringify({ session_id }) }),
  lookupWord: (word) => request(`/api/lookup?word=${encodeURIComponent(word)}`),
  getWeakWords: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/api/student/weak-words${qs ? '?' + qs : ''}`);
  },
  // 断点续做
  getStudentRooms: () => request('/api/student/rooms'),
  saveRoomNote: (room_code, note) => request('/api/student/room/note', { method: 'POST', body: JSON.stringify({ room_code, note }) }),
  leaveRoom: (room_code) => request('/api/student/room/leave', { method: 'POST', body: JSON.stringify({ room_code }) }),
  getResume: (room_code) => request(`/api/practice/resume?room_code=${encodeURIComponent(room_code)}`),
  getLatestSession: (room_code) => request(`/api/student/room/${encodeURIComponent(room_code)}/session/latest`),
  // 教师数据
  getRoomStudents: (roomId) => request(`/api/teacher/room/${roomId}/students`),
  getStudentDetails: (roomId, studentId) => request(`/api/teacher/room/${roomId}/student/${studentId}/details`),
  getWordStats: (roomId) => request(`/api/teacher/room/${roomId}/word-stats`),
  // 管理员
  adminLogin: (data) => request('/api/admin/login', { method: 'POST', body: JSON.stringify(data) }),
  getAllTeachers: () => request('/api/admin/teachers'),
  getAllStudents: () => request('/api/admin/students'),
  updateTeacherStatus: (id, isActive) => request(`/api/admin/teacher/${id}/status`, { method: 'PUT', body: JSON.stringify({ is_active: isActive }) }),
};
