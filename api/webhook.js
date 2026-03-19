export default async function handler(req, res) {
  console.log("=== NEW VERSION LIVE ===");

  return res.status(200).json({
    ok: true,
    test: "werkt"
  });
}
