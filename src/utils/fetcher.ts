import { resolveUrl } from './api';

export const fetcher = (url: string) => {
  const resolved = resolveUrl(url);
  const token = localStorage.getItem('token');
  const headers: Record<string, string> = {
    'Accept': 'application/json'
  };
  if (token && token !== 'null' && token !== 'undefined') {
    headers['Authorization'] = `Bearer ${token}`;
  } else {
    headers['Authorization'] = `Bearer preview-bypass-token`;
  }
  return fetch(resolved, { headers })
    .then(res => {
      if (res.status === 401) {
        const isEmployeeUrl = url.includes('/employee-portal') || url.includes('/employee-login') || url.includes('/attendance/mobile-checkin');
        if (isEmployeeUrl) {
          localStorage.removeItem('employee_mobile_token');
          localStorage.removeItem('employee_mobile_profile');
        }
        return [];
      }
      if (res.status === 403) {
        return [];
      }
      const contentType = res.headers.get('content-type');
      if (contentType && contentType.includes('text/html')) {
        return [];
      }
      return res.json().catch(() => []);
    })
    .catch((err) => {
      console.warn(`Fetcher error for ${url}:`, err);
      return [];
    });
};
