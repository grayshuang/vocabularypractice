export function getToken() {
  return localStorage.getItem('token');
}

export function getUserType() {
  return localStorage.getItem('userType');
}

export function setAuth(token, user, userType) {
  localStorage.setItem('token', token);
  localStorage.setItem('user', JSON.stringify(user));
  localStorage.setItem('userType', userType);
}

export function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  localStorage.removeItem('userType');
}

export function isLoggedIn() {
  return !!getToken();
}
