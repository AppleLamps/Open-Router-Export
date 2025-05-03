// content.js
// This script is injected into the OpenRouter activity page and handles all export logic
// MODIFIED: Always assumes the year is 2025 for timestamps.

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'startExport') {
    // Store export parameters in localStorage to persist across page reloads
    localStorage.setItem('or_export_active', 'true');
    localStorage.setItem('or_export_startPage', request.startPage);
    localStorage.setItem('or_export_endPage', request.endPage);
    localStorage.setItem('or_export_currentPage', request.startPage);
    localStorage.setItem('or_export_data', '[]');
    localStorage.setItem('or_export_skipped', '0');
    // Start export on this page
    runExportFromStorage();
    sendResponse({ success: true, started: true });
    return true;
  }
});

// On every page load, check if export is active and continue if so
if (localStorage.getItem('or_export_active') === 'true') {
  runExportFromStorage();
}

// Main export runner that persists state across page reloads
async function runExportFromStorage() {
  // Prevent re-entrancy
  if (window.__or_export_running) return;
  window.__or_export_running = true;

  try {
    const startPage = parseInt(localStorage.getItem('or_export_startPage'), 10);
    const endPage = parseInt(localStorage.getItem('or_export_endPage'), 10);
    let currentPage = parseInt(localStorage.getItem('or_export_currentPage'), 10);
    let allData = JSON.parse(localStorage.getItem('or_export_data') || '[]');
    let skippedRows = parseInt(localStorage.getItem('or_export_skipped') || '0', 10);

    // Wait for table to appear before extracting data
    await waitForTableRows();

    // Extract data from the current page
    const { pageData, skipped } = extractTableDataWithWarnings();
    skippedRows += skipped;

    // Add page number to data for debugging
    const pageDataWithPageNum = pageData.map(item => ({
      ...item,
      page: currentPage
    }));

    allData.push(...pageDataWithPageNum);

    // Save progress
    localStorage.setItem('or_export_data', JSON.stringify(allData));
    localStorage.setItem('or_export_skipped', skippedRows.toString());

    // Send progress update to popup
    chrome.runtime.sendMessage({
      type: 'progress',
      page: currentPage,
      totalPages: endPage - startPage + 1,
      records: pageData.length,
      skipped,
    });

    // Log progress (for debugging)
    console.log(`Exported page ${currentPage}, got ${pageData.length} records, skipped ${skipped} malformed rows`);

    if (currentPage < endPage) {
      // Move to next page
      localStorage.setItem('or_export_currentPage', (currentPage + 1).toString());
      setTimeout(() => {
        window.location.href = `https://openrouter.ai/activity?page=${currentPage + 1}`;
      }, 1000); // Reduced delay to 1 second
    } else {
      // Export complete
      // Convert data to CSV
      let csv = 'Timestamp,Model,App,Input Tokens,Output Tokens,Cost,Speed,Provider,Page\n';
      allData.forEach(row => {
        // Clean up Cost and Speed for numerical export
        const cleanedCost = (row.cost || '').replace(/[$,]/g, '').trim();
        const cleanedSpeed = (row.speed || '').replace(/tps/g, '').trim();

        csv += `"${row.timestamp}","${row.model}","${row.app}","${row.inputTokens}","${row.outputTokens}","${cleanedCost}","${cleanedSpeed}","${row.provider}","${row.page}"\n`;
      });

      // Add summary information
      if (allData.length > 0) {
        csv += '\n"Summary Information"\n';
        csv += `"Total Records","${allData.length}"\n`;
        csv += `"Pages Processed","${startPage} to ${endPage}"\n`;
        csv += `"Malformed Rows Skipped","${skippedRows}"\n`;

        // Calculate total cost if possible
        try {
          const totalCost = allData.reduce((sum, row) => {
            const cost = parseFloat((row.cost || '').replace(/[$,]/g, '').trim());
            return isNaN(cost) ? sum : sum + cost;
          }, 0);
          csv += `"Total Cost","${totalCost.toFixed(4)}"\n`;
        } catch (e) {
          console.error('Error calculating total cost:', e);
        }
      }

      // Generate filename with page range
      const filename = `openrouter_activity_pages_${startPage}_to_${endPage}.csv`;

      // Create and download the CSV file
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      link.setAttribute('href', url);
      link.setAttribute('download', filename);
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      // Send completion message
      chrome.runtime.sendMessage({
        type: 'progress',
        page: currentPage,
        totalPages: endPage - startPage + 1,
        records: pageData.length,
        skipped,
      });
      setTimeout(() => {
        chrome.runtime.sendMessage({
          success: true,
          count: allData.length,
          skippedRows,
        });
      }, 100);

      // Clean up
      localStorage.removeItem('or_export_active');
      localStorage.removeItem('or_export_startPage');
      localStorage.removeItem('or_export_endPage');
      localStorage.removeItem('or_export_currentPage');
      localStorage.removeItem('or_export_data');
      localStorage.removeItem('or_export_skipped');
      window.__or_export_running = false;
    }
  } catch (error) {
    chrome.runtime.sendMessage({ success: false, error: error.message });
    // Clean up on error
    localStorage.removeItem('or_export_active');
    localStorage.removeItem('or_export_startPage');
    localStorage.removeItem('or_export_endPage');
    localStorage.removeItem('or_export_currentPage');
    localStorage.removeItem('or_export_data');
    localStorage.removeItem('or_export_skipped');
    window.__or_export_running = false;
  }
}

/**
 * Waits for table rows to appear in the DOM before proceeding.
 * Polls every 200ms, up to 10 seconds.
 */
async function waitForTableRows(maxWaitMs = 10000, pollIntervalMs = 200) {
  let waited = 0;
  let rows = [];
  while (waited < maxWaitMs) {
    rows = document.querySelectorAll('table tbody tr');
    if (rows.length > 0) break;
    await new Promise(res => setTimeout(res, pollIntervalMs));
    waited += pollIntervalMs;
  }
  console.log('[OpenRouter Exporter] Rows found:', rows.length);
  if (rows.length === 0) {
    console.warn('[OpenRouter Exporter] No table rows found after waiting. Export may be empty.');
  }
}

// Extracts table data and filters by date, logs warnings for malformed rows
// MODIFIED: Always assumes the year is 2025 for timestamps.
function extractTableDataWithWarnings() {
  // Use a less restrictive selector to target all activity table rows
  const rows = document.querySelectorAll('table tbody tr');
  console.log('[OpenRouter Exporter] Extracting from', rows.length, 'rows');
  // Log a sample of the first 3 rows for debugging
  rows.forEach((row, idx) => {
    if (idx < 3) {
      console.log('[OpenRouter Exporter] Row sample', idx, row.innerText);
    }
  });
  const pageData = [];
  let skipped = 0;

  rows.forEach(row => {
    const cells = row.querySelectorAll('td');
    if (cells.length >= 7) {
      const timestamp = cells[0].textContent.trim();
      // Parse tokens
      let inputTokens = '';
      let outputTokens = '';
      const tokenTitle = cells[3].getAttribute('title');
      if (tokenTitle) {
        // Parse "Prompt: X, Completion: Y" from title attribute
        const titleMatch = tokenTitle.match(/Prompt:\s*([\d,]+),\s*Completion:\s*([\d,]+)/i);
        if (titleMatch) {
          inputTokens = titleMatch[1].replace(/,/g, '');
          outputTokens = titleMatch[2].replace(/,/g, '');
        } else {
          inputTokens = '';
          outputTokens = '';
          console.warn('Unparseable token title format:', tokenTitle, 'in row:', row.innerText);
        }
      } else {
        // Fallback to text content logic
        const tokensText = cells[3].textContent.trim();
        const tokenMatch = tokensText.match(/([\d,]+)\s*→\s*([\d,]+)/); // Unicode arrow
        if (tokenMatch) {
          inputTokens = tokenMatch[1].replace(/,/g, '');
          outputTokens = tokenMatch[2].replace(/,/g, '');
        } else {
          // Handle cases where tokens might be just one number or different format
          const singleNumberMatch = tokensText.match(/^[\d,]+$/);
          if (singleNumberMatch) {
            inputTokens = tokensText.replace(/,/g, '');
            outputTokens = '0'; // Assume 0 output if format is just input tokens
          } else {
            outputTokens = 'N/A';
            console.warn('Unparseable token format:', tokensText, 'in row:', row.innerText);
          }
        }
      }

      pageData.push({
        timestamp, // Keep original timestamp string
        model: cells[1].textContent.trim(),
        app: cells[2].textContent.trim(),
        inputTokens: inputTokens, // Use parsed input tokens
        outputTokens: outputTokens, // Use parsed output tokens
        cost: cells[4].textContent.trim(),
        speed: cells[5].textContent.trim(),
        provider: cells[6].textContent.trim()
      });
    } else {
      skipped++;
      console.warn('Malformed row skipped (less than 7 cells):', row.innerText);
    }
  });

  return { pageData, skipped };
}

// Helper: get month number from month name
function getMonthNumber(monthName) {
  const months = {
    'Jan': 1, 'Feb': 2, 'Mar': 3, 'Apr': 4, 'May': 5, 'Jun': 6,
    'Jul': 7, 'Aug': 8, 'Sep': 9, 'Oct': 10, 'Nov': 11, 'Dec': 12
  };
  // Use substring to handle potential full month names vs abbreviations
  return months[monthName.substring(0, 3)] || 1; // Default to Jan if not found
}

// Helper: navigate to a specific page using window.location.href and poll for table/page indicator
async function goToPage(pageNum) {
  const url = `https://openrouter.ai/activity?page=${pageNum}`;
  if (window.location.href !== url) {
    console.log(`Navigating to page ${pageNum}...`);
    window.location.href = url;
    // Basic wait after navigation - consider adding polling if needed
    await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 seconds for page load
  }
}
