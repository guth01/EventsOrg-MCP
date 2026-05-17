import fetch from "node-fetch";

async function simulateIncomingSms() {
  const webhookUrl = "http://localhost:3000/webhook/sms";
  
  // This is exactly what Twilio's server sends to our webhook
  const twilioPayload = new URLSearchParams({
    From: "+919999999999", // A fake personal number
    Body: "Hey, I'm stuck in traffic, will be about 20 minutes late to my zone.",
  });

  console.log(`🚀 Simulating Twilio sending an SMS to ${webhookUrl}...`);
  console.log(`📩 Message: "${twilioPayload.get("Body")}"`);

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: twilioPayload.toString(),
    });

    const text = await res.text();
    console.log(`\n✅ Webhook responded with status: ${res.status}`);
    console.log(`📄 Response body: ${text}`);
    console.log(`\n🎉 Success! The webhook processed the message.`);
    console.log(`Ask Claude Desktop: "Pull the SMS history for +919999999999" to see how Gemini classified it!`);
  } catch (err) {
    console.error("❌ Failed to connect to webhook. Is Claude Desktop running?", err);
  }
}

simulateIncomingSms();
