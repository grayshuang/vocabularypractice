import { useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import { setAuth } from '../auth';

// 教师端登录：只认教师账密。下方提供「管理员入口」链接。
export default function TeacherLogin({ onSuccess }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await api.teacherLogin({ username, password });
      if (res.token) {
        setAuth(res.token, res.teacher, 'teacher');
        if (onSuccess) onSuccess();
      }
    } catch (err) {
      setError(err.response?.data?.error || '用户名或密码错误');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-md">
        <h2 className="text-2xl font-bold text-center text-gray-800 mb-2">教师登录</h2>
        <p className="text-center text-sm text-gray-500 mb-6">进入教师控制台前请先登录</p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <input type="text" placeholder="用户名" value={username} onChange={e => setUsername(e.target.value)} className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent" required />
          <input type="password" placeholder="密码" value={password} onChange={e => setPassword(e.target.value)} className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent" required />
          {error && <p className="text-red-600 text-sm bg-red-50 p-2 rounded">{error}</p>}
          <button type="submit" disabled={loading} className="w-full py-2 px-4 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition disabled:opacity-50">
            {loading ? '登录中...' : '登录'}
          </button>
        </form>
        <p className="mt-4 text-center text-sm text-gray-600">
          还没有账号？<Link to="/register" className="text-indigo-600 hover:text-indigo-800">注册</Link>
        </p>
        <p className="mt-2 text-center text-xs text-gray-400">
          <Link to="/admin/login" className="hover:text-red-600">管理员入口 →</Link>
        </p>
      </div>
    </div>
  );
}
