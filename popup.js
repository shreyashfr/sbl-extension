// Check LinkedIn auth status and show in popup
async function checkStatus() {
  const statusBox = document.getElementById('statusBox');
  const details = document.getElementById('details');

  try {
    const allCookies = await chrome.cookies.getAll({ domain: '.linkedin.com' });
    const li_at = allCookies.find(c => c.name === 'li_at');
    const jsessionid = allCookies.find(c => c.name === 'JSESSIONID');
    const li_a = allCookies.find(c => c.name === 'li_a');

    details.textContent = `Cookies found: ${allCookies.length} | li_at: ${li_at ? 'yes' : 'no'} | JSESSIONID: ${jsessionid ? 'yes' : 'no'} | li_a: ${li_a ? 'yes' : 'no'}`;

    if (li_at && jsessionid) {
      statusBox.className = 'status ok';
      statusBox.textContent = 'LinkedIn session active. Ready to search!';
    } else if (li_at) {
      statusBox.className = 'status warn';
      statusBox.textContent = 'li_at found but no JSESSIONID. Try refreshing linkedin.com';
    } else {
      statusBox.className = 'status err';
      statusBox.textContent = 'Not logged into LinkedIn. Please log in at linkedin.com';
    }
  } catch (err) {
    statusBox.className = 'status err';
    statusBox.textContent = 'Error: ' + err.message;
  }
}

checkStatus();
