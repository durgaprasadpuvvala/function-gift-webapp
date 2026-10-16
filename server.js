
require("dotenv").config();

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const Razorpay = require("razorpay");
const PDFDocument = require("pdfkit");

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL &&
    !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false }
    : false
});

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gifts (
      id BIGSERIAL PRIMARY KEY,
      guest_name VARCHAR(120) NOT NULL,
      address TEXT NOT NULL,
      phone VARCHAR(20) NOT NULL,
      amount_paise INTEGER NOT NULL,
      order_id VARCHAR(100) UNIQUE NOT NULL,
      payment_id VARCHAR(100) UNIQUE,
      status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function validText(value, maxLength) {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= maxLength;
}

app.get("/api/config", (req, res) => {
  res.json({
    functionName: process.env.FUNCTION_NAME || "Function Gift",
    ownerUpiId: process.env.OWNER_UPI_ID || ""
  });
});

// 1. Create order and save guest details
app.post("/api/create-order", async (req, res) => {
  try {
    const { guestName, address, phone, amount } = req.body;

    if (
      !validText(guestName, 120) ||
      !validText(address, 1000) ||
      !validText(phone, 20) ||
      !/^[+0-9 ()-]{8,20}$/.test(phone)
    ) {
      return res.status(400).json({
        error: "Enter valid guest details."
      });
    }

    const value = Number(amount);

    if (!Number.isFinite(value) || value < 1 || value > 1000000) {
      return res.status(400).json({
        error: "Amount must be between ₹1 and ₹10,00,000."
      });
    }

    const paise = Math.round(value * 100);

    const order = await razorpay.orders.create({
      amount: paise,
      currency: "INR",
      receipt: `gift_${Date.now()}`,
      notes: {
        guest_name: guestName.trim(),
        phone: phone.trim(),
        owner_upi_id: process.env.OWNER_UPI_ID || ""
      }
    });

    await pool.query(
      `INSERT INTO gifts
       (guest_name, address, phone, amount_paise, order_id, status)
       VALUES ($1, $2, $3, $4, $5, 'PENDING')`,
      [
        guestName.trim(),
        address.trim(),
        phone.trim(),
        paise,
        order.id
      ]
    );

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
      functionName: process.env.FUNCTION_NAME || "Function Gift"
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Unable to start payment. Please try again."
    });
  }
});

// 2. Verify payment signature and provider status
app.post("/api/verify-payment", async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    } = req.body;

    if (
      ![razorpay_order_id, razorpay_payment_id, razorpay_signature]
        .every(v => typeof v === "string")
    ) {
      return res.status(400).json({ error: "Invalid payment details." });
    }

    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    const a = Buffer.from(expected);
    const b = Buffer.from(razorpay_signature);

    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(400).json({
        error: "Payment verification failed."
      });
    }

    const payment = await razorpay.payments.fetch(razorpay_payment_id);

    if (
      payment.order_id !== razorpay_order_id ||
      payment.status !== "captured"
    ) {
      return res.status(409).json({
        error: "Payment is not confirmed as captured."
      });
    }

    const result = await pool.query(
      `UPDATE gifts
       SET payment_id = $1, status = 'SUCCESS'
       WHERE order_id = $2
         AND amount_paise = $3
       RETURNING id, guest_name, amount_paise, payment_id`,
      [razorpay_payment_id, razorpay_order_id, payment.amount]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Matching payment record was not found."
      });
    }

    res.json({
      success: true,
      paymentId: result.rows[0].payment_id
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Could not verify payment. Contact the organizer."
    });
  }
});

// 3. Retrieve verified receipt data only
app.get("/api/receipt/:paymentId", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT guest_name, address, phone, amount_paise,
              order_id, payment_id, created_at
       FROM gifts
       WHERE payment_id = $1 AND status = 'SUCCESS'`,
      [req.params.paymentId]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Verified receipt not found."
      });
    }

    const row = result.rows[0];

    res.json({
      ...row,
      amount: (row.amount_paise / 100).toFixed(2),
      functionName: process.env.FUNCTION_NAME || "Function Gift",
      ownerName: process.env.FUNCTION_OWNER || "Function Organizer"
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Unable to load receipt." });
  }
});

// 4. Generate an actual PDF after verified payment
app.get("/api/receipt/:paymentId/pdf", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT guest_name, address, phone, amount_paise,
              order_id, payment_id, created_at
       FROM gifts
       WHERE payment_id = $1 AND status = 'SUCCESS'`,
      [req.params.paymentId]
    );

    if (!result.rowCount) {
      return res.status(404).send("Verified receipt not found.");
    }

    const row = result.rows[0];
    const doc = new PDFDocument({ margin: 55 });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="gift-receipt-${row.payment_id}.pdf"`
    );

    doc.pipe(res);

    doc.fontSize(23).text(
      process.env.FUNCTION_NAME || "Function Gift",
      { align: "center" }
    );
    doc.moveDown();
    doc.fontSize(17).text("GIFT PAYMENT RECEIPT", {
      align: "center"
    });
    doc.moveDown();
    doc.fontSize(12).text("Payment Status: SUCCESS");
    doc.moveDown();

    doc.text(`Guest Name: ${row.guest_name}`);
    doc.moveDown(0.5);
    doc.text(`Address: ${row.address}`);
    doc.moveDown(0.5);
    doc.text(`Phone: ${row.phone}`);
    doc.moveDown(0.5);
    doc.text(
      `Gift Amount: INR ${(row.amount_paise / 100).toFixed(2)}`
    );
    doc.moveDown(0.5);
    doc.text(`Transaction ID: ${row.payment_id}`);
    doc.moveDown(0.5);
    doc.text(`Order ID: ${row.order_id}`);
    doc.moveDown(0.5);
    doc.text(`Date: ${new Date(row.created_at).toLocaleString("en-IN")}`);
    doc.moveDown(2);
    doc.fontSize(10).text(
      `Received by: ${process.env.FUNCTION_OWNER || "Function Organizer"}`
    );
    doc.moveDown();
    doc.text("Thank you for your blessings and good wishes.");

    doc.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).send("Could not generate receipt.");
    }
  }
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Function Gift app running at http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error("Database initialization failed:", err);
    process.exit(1);
  });
