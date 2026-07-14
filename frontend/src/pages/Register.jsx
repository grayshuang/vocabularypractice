import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import { setAuth, getUserType } from '../auth';

export default function Register() {
  const [role, setRole] = useState('student');
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [studentType, setStudentType] = useState('班课');
  const [classCode, setClassCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    const data = { name, username, password, email };
    if (role === 'student') {
      data.student_type = studentType;
      data.class_code = classCode;
    }
    try {
      const res = role === 'student'
        ? await api.studentRegister(data)
        : await api.teacherRegister(data);
      if (res.error) setError(res.error);
      else {
        const loginRes = role === 'student'
          ? await api.studentLogin({ username, password })
          : await api.teacherLogin({ username, password });
        if (loginRes.token) {
          setAuth(loginRes.token, loginRes.student || loginRes.teacher, role === 'student' ? 'student' : 'teacher');
          navigate(role === 'student' ? '/student' : '/teacher');
        }
      }
    } catch (err) {
      setError(err.response?.data?.error || '注册失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-md">
        <h2 className="text-2xl font-bold text-center text-gray-800 mb-6">注册账号</h2>

        {/* 角色选择 */}
        <div className="flex gap-2 mb-6">
          {['student', 'teacher'].map(r => (
            <button
              key={r}
              onClick={() => setRole(r)}
              className={`flex-1 py-2 rounded-lg font-medium transition ${role === r ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            >
              {r === 'student' ? '学生' : '教师'}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <input type="text" placeholder="姓名" value={name} onChange={e => setName(e.target.value)} className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent" required />
          <input type="text" placeholder="用户名" value={username} onChange={e => setUsername(e.target.value)} className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent" required />
          <input type="email" placeholder="邮箱" value={email} onChange={e => setEmail(e.target.value)} className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent" required />
          <input type="password" placeholder="密码" value={password} onChange={e => setPassword(e.target.value)} className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent" required />
          {role === 'student' && (
            <>
              <div className="flex gap-2">
                {['班课', '1v1'].map(t => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setStudentType(t)}
                    className={`flex-1 py-2 rounded-lg font-medium transition ${studentType === t ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600'}`}
                  >
                    {t}
                  </button>
                ))}
              </div>
              {studentType === '班课' && (
                <input type="text" placeholder="班号" value={classCode} onChange={e => setClassCode(e.target.value)} className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent" required />
              )}
            </>
          )}
          {error && <p className="text-red-600 text-sm bg-red-50 p-2 rounded">{error}</p>}
          <button type="submit" disabled={loading} className="w-full py-2 px-4 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition disabled:opacity-50">
            {loading ? '注册中...' : '注册'}
          </button>
        </form>
        <p className="mt-4 text-center text-sm text-gray-600">
          已有账号？<a href={role === 'teacher' ? '/teacher' : '/student'} className="text-indigo-600 hover:text-indigo-800">登录</a>
        </p>
      </div>
    </div>
  );
}
