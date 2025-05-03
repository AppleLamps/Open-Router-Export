// popup.js
document.addEventListener('DOMContentLoaded', function() {
  const exportButton = document.getElementById('exportButton');
  const statusDiv = document.getElementById('status');
  const startPageInput = document.getElementById('startPage');
  const endPageInput = document.getElementById('endPage');
  const spinner = document.getElementById('exportSpinner');

  // Helper to set status with animation and color
  function setStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = 'status-card' + (type ? ` ${type}` : '');
    statusDiv.style.opacity = 0.7;
    setTimeout(() => { statusDiv.style.opacity = 1; }, 60);
  }

  exportButton.addEventListener('click', async () => {
    const startPage = parseInt(startPageInput.value);
    const endPage = parseInt(endPageInput.value);

    // Reset status
    setStatus('', '');

    if (startPage > endPage) {
      setStatus('Error: Start page must be less than or equal to end page.', 'error');
      return;
    }

    setStatus('Starting export...', 'progress');
    if (spinner) spinner.style.display = 'inline-flex';
    exportButton.disabled = true;
    exportButton.classList.add('loading');

    try {
      // Get the active tab
      let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      // Check if we're on the right page
      if (!tab.url.includes('openrouter.ai/activity')) {
        setStatus('Error: This extension only works on the OpenRouter activity page.', 'error');
        if (spinner) spinner.style.display = 'none';
        exportButton.disabled = false;
        exportButton.classList.remove('loading');
        return;
      }

      // Send a message to the content script to start export
      chrome.tabs.sendMessage(
        tab.id,
        {
          action: 'startExport',
          startPage,
          endPage
        },
        (response) => {
          // Only handle immediate errors in starting the export
          if (chrome.runtime.lastError) {
            if (spinner) spinner.style.display = 'none';
            exportButton.disabled = false;
            exportButton.classList.remove('loading');
            setStatus('Error: ' + chrome.runtime.lastError.message, 'error');
          } else if (!response || !response.success) {
            if (spinner) spinner.style.display = 'none';
            exportButton.disabled = false;
            exportButton.classList.remove('loading');
            setStatus('Error: Could not start export.', 'error');
          }
          // Otherwise, export will proceed asynchronously and UI will update via onMessage
        }
      );
    } catch (error) {
      if (spinner) spinner.style.display = 'none';
      exportButton.disabled = false;
      exportButton.classList.remove('loading');
      setStatus('Error: ' + error.message, 'error');
    }
  });

  // Listen for progress, error, and completion messages from content.js
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!statusDiv) return;

    if (message.type === 'progress') {
      setStatus(
        `Processing page ${message.page} of ${message.totalPages}... Extracted ${message.records} records, skipped ${message.skipped} malformed rows.`,
        'progress'
      );
      if (spinner) spinner.style.display = 'inline-flex';
      exportButton.disabled = true;
      exportButton.classList.add('loading');
    } else if (message.type === 'error') {
      setStatus(`Error on page ${message.page}: ${message.error}`, 'error');
      if (spinner) spinner.style.display = 'none';
      exportButton.disabled = false;
      exportButton.classList.remove('loading');
    } else if (message.success === true) {
      let msg = `Export complete! ${message.count} records exported.`;
      if (message.skippedRows && message.skippedRows > 0) {
        msg += ` (${message.skippedRows} malformed rows skipped)`;
      }
      setStatus(msg, 'success');
      if (spinner) spinner.style.display = 'none';
      exportButton.disabled = false;
      exportButton.classList.remove('loading');
    } else if (message.success === false && message.error) {
      setStatus('Error: ' + message.error, 'error');
      if (spinner) spinner.style.display = 'none';
      exportButton.disabled = false;
      exportButton.classList.remove('loading');
    }
  });
});
