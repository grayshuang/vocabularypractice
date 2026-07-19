import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import api from '../api';
import { setAuth } from '../auth';

// 学生端登录：只认学生账密。下方提供「管理员入口」与「注册」链接。
export default function StudentLogin({ onSuccess }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  // 忘记密码弹窗状态
  const [showReset, setShowReset] = useState(false);
  const [rEmail, setREmail] = useState('');
  const [rPassword, setRPassword] = useState('');
  const [rPassword2, setRPassword2] = useState('');
  const [rMsg, setRMsg] = useState('');
  const [rLoading, setRLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await api.studentLogin({ username, password });
      if (res.token) {
        setAuth(res.token, res.student, 'student');
        if (onSuccess) onSuccess();
        else navigate('/student');
      }
    } catch (err) {
      const msg = err && err.message ? err.message : '登录失败，请检查用户名和密码';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  async function handleReset(e) {
    e.preventDefault();
    setRMsg('');
    if (rPassword !== rPassword2) {
      setRMsg('⚠️ 两次输入的密码不一致');
      return;
    }
    if (String(rPassword).length < 4) {
      setRMsg('⚠️ 新密码至少 4 位');
      return;
    }
    setRLoading(true);
    try {
      const res = await api.post('/api/student/reset-password', { email: rEmail, newPassword: rPassword });
      setRMsg('✅ ' + (res.message || '密码重置成功，请用新密码登录'));
      setTimeout(() => { setShowReset(false); setRMsg(''); }, 2500);
    } catch (err) {
      const msg = err && err.message ? err.message : '重置失败，请重试';
      setRMsg('⚠️ ' + msg);
    } finally {
      setRLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-md">
        <h2 className="text-2xl font-bold text-center text-gray-800 mb-2">学生登录</h2>
        <p className="text-center text-sm text-gray-500 mb-6">进入练习前请先登录学生账号</p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <input type="text" placeholder="用户名" value={username} onChange={e => setUsername(e.target.value)} className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent" required />
          <input type="password" placeholder="密码" value={password} onChange={e => setPassword(e.target.value)} className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent" required />
          {error && <p className="text-red-600 text-sm bg-red-50 p-2 rounded">{error}</p>}
          <button type="submit" disabled={loading} className="w-full py-2 px-4 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition disabled:opacity-50">
            {loading ? '登录中...' : '登录'}
          </button>
        </form>
        <div className="mt-4 flex items-center justify-between">
          <Link to="/register" className="text-sm text-indigo-600 hover:text-indigo-800">还没有账号？注册</Link>
          <button type="button" className="text-sm font-medium text-orange-600 hover:text-orange-800 underline decoration-orange-300" onClick={() => setShowReset(true)}>忘记密码？</button>
        </div>
        <p className="mt-3 text-center text-xs text-gray-400">
          <Link to="/admin/login" className="hover:text-red-600">管理员入口 →</Link>
        </p>
      </div>

      {showReset && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm">
            <h3 className="text-lg font-bold text-gray-800 mb-1">重置学生密码</h3>
            <p className="text-xs text-gray-500 mb-4">输入注册邮箱验证身份后直接设置新密码</p>
            <form onSubmit={handleReset} className="space-y-3">
              <input type="email" placeholder="注册邮箱" value={rEmail} onChange={e => setREmail(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" required />
              <input type="password" placeholder="新密码（至少 4 位）" value={rPassword} onChange={e => setRPassword(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" required />
              <input type="password" placeholder="确认新密码" value={rPassword2} onChange={e => setRPassword2(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" required />
              {rMsg && <p className={`text-sm p-2 rounded ${rMsg.startsWith('✅') ? 'text-green-700 bg-green-50' : 'text-red-600 bg-red-50'}`}>{rMsg}</p>}
              <div className="flex gap-2 pt-1">
                <button type="submit" disabled={rLoading} className="flex-1 py-2 px-4 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm disabled:opacity-50">
                  {rLoading ? '处理中...' : '重置密码'}
                </button>
                <button type="button" onClick={() => { setShowReset(false); setRMsg(''); }} className="flex-1 py-2 px-4 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 text-sm">
                  取消
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
