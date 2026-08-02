import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useState } from 'react';
import StudentHome from './pages/StudentHome';
import Practice from './pages/Practice';
import History from './pages/History';
import AdminLogin from './pages/AdminLogin';
import AdminDashboard from './pages/AdminDashboard';
import Dashboard from './pages/Dashboard';
import RoomDashboard from './pages/RoomDashboard';
import LexiconManager from './pages/LexiconManager';
import Register from './pages/Register';
import StudentLogin from './pages/StudentLogin';
import TeacherLogin from './pages/TeacherLogin';
import { getToken, getUserType } from './auth';

// 通用角色守卫
function ProtectedRoute({ children, allowedType }) {
  const token = getToken();
  const userType = getUserType();
  if (!token) {
    return <Navigate to={allowedType === 'admin' ? '/admin/login' : allowedType === 'teacher' ? '/teacher' : '/student'} />;
  }
  if (allowedType && userType !== allowedType) return <Navigate to="/" />;
  return children;
}

// 仅学生可进入的页面（练习 / 历史）
function StudentProtected({ children }) {
  const token = getToken();
  const userType = getUserType();
  if (!token || userType !== 'student') return <Navigate to="/student" />;
  return children;
}

// 网址 A：学生端入口（只认学生账密）
function StudentEntry() {
  const [v, setV] = useState(0);
  const token = getToken();
  const userType = getUserType();
  if (token && userType === 'student') return <StudentHome />;
  return <StudentLogin onSuccess={() => setV(x => x + 1)} />;
}

// 网址 B：教师端入口（只认教师账密）
function TeacherEntry() {
  const [v, setV] = useState(0);
  const token = getToken();
  const userType = getUserType();
  if (token && userType === 'teacher') return <Dashboard />;
  return <TeacherLogin onSuccess={() => setV(x => x + 1)} />;
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* 根路径默认进入学生端 */}
        <Route path="/" element={<Navigate to="/student" />} />

        {/* 网址 A：学生端（只进入学生练习） */}
        <Route path="/student" element={<StudentEntry />} />

        {/* 网址 B：教师端（只进入教师后台） */}
        <Route path="/teacher" element={<TeacherEntry />} />

        {/* 兼容旧书签：统一跳到学生端 */}
        <Route path="/login" element={<Navigate to="/student" />} />
        <Route path="/register" element={<Register />} />

        {/* 超级管理员登录页（两端下方均有入口链接指向这里） */}
        <Route path="/admin/login" element={<AdminLogin />} />

        {/* 学生练习相关（需学生令牌） */}
        <Route path="/practice" element={<StudentProtected><Practice /></StudentProtected>} />
        <Route path="/history" element={<StudentProtected><History /></StudentProtected>} />

        {/* 教师后台（需教师令牌） */}
        <Route path="/dashboard" element={<ProtectedRoute allowedType="teacher"><Dashboard /></ProtectedRoute>} />
        <Route path="/lexicon" element={<ProtectedRoute allowedType="teacher"><LexiconManager /></ProtectedRoute>} />
        <Route path="/room/:roomCode" element={<ProtectedRoute allowedType="teacher"><RoomDashboard /></ProtectedRoute>} />

        {/* 超级管理员后台（需 admin 令牌） */}
        <Route path="/admin" element={<ProtectedRoute allowedType="admin"><AdminDashboard /></ProtectedRoute>} />

        {/* 兜底 */}
        <Route path="*" element={<Navigate to="/student" />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
