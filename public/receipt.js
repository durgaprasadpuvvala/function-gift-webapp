
const statusElement = document.getElementById("status");
const receiptElement = document.getElementById("receipt");

const paymentId = new URLSearchParams(location.search)
  .get("payment_id");

function safe(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

async function loadReceipt() {
  if (!paymentId) {
    statusElement.textContent = "Payment ID is missing.";
    return;
  }

  try {
    const response = await fetch(
      "/api/receipt/" + encodeURIComponent(paymentId)
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Receipt not available.");
    }

    statusElement.textContent = "✓ Payment verified successfully";

    receiptElement.innerHTML = `
      <h2>${safe(data.functionName)}</h2>
      <p>Received by: ${safe(data.ownerName)}</p>

      <h1>₹${safe(data.amount)}</h1>

      <p><strong>Guest:</strong> ${safe(data.guest_name)}</p>
      <p><strong>Address:</strong> ${safe(data.address)}</p>
      <p><strong>Phone:</strong> ${safe(data.phone)}</p>

      <p><strong>Transaction ID:</strong></p>
      <p style="overflow-wrap:anywhere">
        ${safe(data.payment_id)}
      </p>

      <p><strong>Order ID:</strong></p>
      <p style="overflow-wrap:anywhere">
        ${safe(data.order_id)}
      </p>

      <p><strong>Date:</strong>
        ${safe(new Date(data.created_at).toLocaleString("en-IN"))}
      </p>

      <button class="pay-button" id="downloadPdf">
        Download PDF Receipt ↓
      </button>
    `;

    document.getElementById("downloadPdf").addEventListener(
      "click",
      () => {
        window.location.href =
          "/api/receipt/" + encodeURIComponent(paymentId) + "/pdf";
      }
    );

  } catch (error) {
    statusElement.textContent = error.message;
  }
}

loadReceipt();
