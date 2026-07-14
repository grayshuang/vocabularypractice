import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import { setAuth } from '../auth';

export default function AdminLogin() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await api.adminLogin({ username, password });
      if (res.token) {
        setAuth(res.token, res.admin, 'admin');
        navigate('/admin');
      }
    } catch (err) {
      setError(err.response?.data?.error || '登录失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-red-50 to-orange-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-md">
        <div className="text-center mb-6">
          <div className="text-4xl mb-2">🔑</div>
          <h2 className="text-2xl font-bold text-gray-800">超级管理员登录</h2>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <input type="text" placeholder="管理员账号" value={username} onChange={e => setUsername(e.target.value)} className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent" required />
          <input type="password" placeholder="密码" value={password} onChange={e => setPassword(e.target.value)} className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent" required />
          {error && <p className="text-red-600 text-sm bg-red-50 p-3 rounded">{error}</p>}
          <button type="submit" disabled={loading} className="w-full py-3 px-4 bg-red-600 text-white rounded-lg hover:bg-red-700 transition font-medium disabled:opacity-50">
            {loading ? '登录中...' : '登录'}
          </button>
        </form>
        <p className="mt-4 text-center text-sm text-gray-600">
          <a href="/login" className="text-red-600 hover:text-red-800">← 返回普通登录</a>
        </p>
      </div>
    </div>
  );
}
