
const form = document.getElementById("giftForm");
const message = document.getElementById("message");
const payButton = document.getElementById("payButton");

function showMessage(text, success = false) {
  message.textContent = text;
  message.classList.toggle("success", success);
}

document.querySelectorAll("[data-amount]").forEach(button => {
  button.addEventListener("click", () => {
    document.getElementById("amount").value = button.dataset.amount;
  });
});

fetch("/api/config")
  .then(response => response.json())
  .then(config => {
    document.getElementById("functionName").textContent =
      config.functionName;
  })
  .catch(() => {});

form.addEventListener("submit", async event => {
  event.preventDefault();
  showMessage("");

  if (typeof Razorpay === "undefined") {
    showMessage("Payment service did not load. Check your internet.");
    return;
  }

  const guestName = document.getElementById("guestName").value.trim();
  const address = document.getElementById("address").value.trim();
  const phone = document.getElementById("phone").value.trim();
  const amount = Number(document.getElementById("amount").value);

  if (!guestName || !address || !phone ||
      !Number.isFinite(amount) || amount < 1) {
    showMessage("Please enter all details and a valid amount.");
    return;
  }

  payButton.disabled = true;
  payButton.textContent = "Preparing payment...";

  try {
    const response = await fetch("/api/create-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ guestName, address, phone, amount })
    });

    const order = await response.json();
    if (!response.ok) throw new Error(order.error || "Could not create order.");

    const checkout = new Razorpay({
      key: order.keyId,
      amount: order.amount,
      currency: order.currency,
      name: order.functionName,
      description: "Function gift",
      order_id: order.orderId,
      prefill: {
        name: guestName,
        contact: phone
      },
      notes: { address },
      theme: { color: "#5b3cc4" },

      handler: async payment => {
        showMessage("Verifying your payment...", true);

        try {
          const verifyResponse = await fetch("/api/verify-payment", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payment)
          });

          const result = await verifyResponse.json();

          if (!verifyResponse.ok || !result.success) {
            throw new Error(result.error || "Payment verification failed.");
          }

          window.location.href =
            "/receipt.html?payment_id=" +
            encodeURIComponent(payment.razorpay_payment_id);

        } catch (error) {
          showMessage(
            error.message +
            " Keep your payment ID: " + payment.razorpay_payment_id
          );
        }
      }
    });

    checkout.on("payment.failed", result => {
      showMessage(
        "Payment failed: " +
        (result.error?.description || "Please try again.")
      );
    });

    checkout.open();

  } catch (error) {
    showMessage(error.message || "Unable to start payment.");
  } finally {
    payButton.disabled = false;
    payButton.textContent = "Pay Gift Amount →";
  }
});
