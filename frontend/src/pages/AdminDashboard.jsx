import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import { logout } from '../auth';

export default function AdminDashboard() {
  const [teachers, setTeachers] = useState([]);
  const [students, setStudents] = useState([]);
  const [activeTab, setActiveTab] = useState('overview');
  const [error, setError] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    if (activeTab === 'teachers') loadTeachers();
    if (activeTab === 'students') loadStudents();
  }, [activeTab]);

  async function loadTeachers() {
    try {
      const res = await api.getAllTeachers();
      setTeachers(res.data || res);
    } catch (err) { setError('加载教师列表失败'); }
  }

  async function loadStudents() {
    try {
      const res = await api.getAllStudents();
      setStudents(res.data || res);
    } catch (err) { setError('加载学生列表失败'); }
  }

  async function handleToggleTeacher(id, currentStatus) {
    try {
      await api.updateTeacherStatus(id, !currentStatus);
      loadTeachers();
    } catch (err) { setError('操作失败'); }
  }

  function handleLogout() {
    logout();
    navigate('/admin/login');
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-red-50 to-orange-100">
      {/* 顶部导航 */}
      <nav className="bg-white shadow-sm border-b-2 border-red-600">
        <div className="max-w-7xl mx-auto px-4 py-3 flex justify-between items-center">
          <h1 className="text-xl font-bold text-red-700">🔑 超级管理员后台</h1>
          <button onClick={handleLogout} className="text-sm text-red-600 hover:text-red-800">退出</button>
        </div>
      </nav>

      {/* 侧边栏 + 主内容 */}
      <div className="max-w-7xl mx-auto p-6 flex gap-6">
        {/* 侧边栏 */}
        <div className="w-48 bg-white rounded-xl shadow p-4 space-y-2">
          {[
            { key: 'overview', label: '📊 总览' },
            { key: 'teachers', label: '👨🏫 教师管理' },
            { key: 'students', label: '👨🎓 学生管理' },
          ].map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`w-full text-left px-4 py-2 rounded-lg transition ${activeTab === tab.key ? 'bg-red-100 text-red-700 font-medium' : 'text-gray-600 hover:bg-gray-100'}`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* 主内容 */}
        <div className="flex-1 bg-white rounded-xl shadow p-6">
          {error && <p className="text-red-600 bg-red-50 p-3 rounded mb-4">{error}</p>}

          {/* 总览 */}
          {activeTab === 'overview' && (
            <div>
              <h2 className="text-2xl font-bold text-gray-800 mb-6">平台总览</h2>
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-blue-50 p-6 rounded-xl">
                  <p className="text-sm text-gray-600">教师总数</p>
                  <p className="text-3xl font-bold text-blue-700">{teachers.length}</p>
                </div>
                <div className="bg-green-50 p-6 rounded-xl">
                  <p className="text-sm text-gray-600">学生总数</p>
                  <p className="text-3xl font-bold text-green-700">{students.length}</p>
                </div>
                <div className="bg-indigo-50 p-6 rounded-xl">
                  <p className="text-sm text-gray-600">活跃教师</p>
                  <p className="text-3xl font-bold text-indigo-700">{teachers.filter(t => t.is_active !== false).length}</p>
                </div>
              </div>
              <button onClick={loadTeachers} className="mt-6 px-4 py-2 bg-blue-100 text-blue-700 rounded-lg hover:bg-blue-200 transition">刷新数据</button>
            </div>
          )}

          {/* 教师管理 */}
          {activeTab === 'teachers' && (
            <div>
              <h2 className="text-2xl font-bold text-gray-800 mb-6">教师管理</h2>
              {teachers.length === 0 ? (
                <p className="text-gray-500 text-center py-8">暂无教师数据</p>
              ) : (
                <div className="space-y-3">
                  {teachers.map(teacher => (
                    <div key={teacher.id} className="border border-gray-200 rounded-lg p-4 flex justify-between items-center">
                      <div>
                        <p className="font-bold text-lg">{teacher.name || teacher.username}</p>
                        <p className="text-sm text-gray-600">账号：{teacher.username} | 邮箱：{teacher.email}</p>
                        <p className="text-xs text-gray-500">注册时间：{new Date(teacher.created_at).toLocaleString('zh-CN')}</p>
                      </div>
                      <div className="flex gap-2">
                        <span className={`px-3 py-1 rounded-full text-xs ${teacher.is_active !== false ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                          {teacher.is_active !== false ? '正常' : '已禁用'}
                        </span>
                        <button
                          onClick={() => handleToggleTeacher(teacher.id, teacher.is_active !== false)}
                          className={`px-3 py-1 rounded-lg text-sm transition ${teacher.is_active !== false ? 'bg-red-100 text-red-700 hover:bg-red-200' : 'bg-green-100 text-green-700 hover:bg-green-200'}`}
                        >
                          {teacher.is_active !== false ? '禁用' : '启用'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 学生管理 */}
          {activeTab === 'students' && (
            <div>
              <h2 className="text-2xl font-bold text-gray-800 mb-6">学生管理</h2>
              {students.length === 0 ? (
                <p className="text-gray-500 text-center py-8">暂无学生数据</p>
              ) : (
                <div className="space-y-3">
                  {students.map(student => (
                    <div key={student.id} className="border border-gray-200 rounded-lg p-4">
                      <div className="flex justify-between items-start">
                        <div>
                          <p className="font-bold text-lg">{student.name || student.username}</p>
                          <p className="text-sm text-gray-600">账号：{student.username} | 邮箱：{student.email}</p>
                          <p className="text-xs text-gray-500">
                            类型：{student.student_type || '班课'} 
                            {student.class_code ? ` | 班号：${student.class_code}` : ''}
                          </p>
                        </div>
                        <span className={`px-3 py-1 rounded-full text-xs ${student.is_active !== false ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                          {student.is_active !== false ? '正常' : '已禁用'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
