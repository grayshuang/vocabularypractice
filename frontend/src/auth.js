export function getToken() {
  return localStorage.getItem('token');
}

export function getUserType() {
  return localStorage.getItem('userType');
}

export function setAuth(token, user, userType) {
  // 切换账号时先清除旧数据，防止新账号看到旧账号的练习历史/薄弱词
  clearAllAuthData();
  localStorage.setItem('token', token);
  localStorage.setItem('user', JSON.stringify(user));
  localStorage.setItem('userType', userType);
}

/** 清除所有鉴权及账号级缓存数据（切换/登出时调用） */
export function clearAllAuthData() {
  const keysToRemove = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    // 清除 token/user/userType 及所有 fresh_practice:* 缓存
    if (key === 'token' || key === 'user' || key === 'userType' ||
        (key && key.startsWith('fresh_practice:'))) {
      keysToRemove.push(key);
    }
  }
  keysToRemove.forEach(k => localStorage.removeItem(k));
}

export function logout() {
  clearAllAuthData();
}

export function isLoggedIn() {
  return !!getToken();
}
