// /src//api/accounting/syncQuickbooksReports.js
import { pullPnlPdfsForYear } from '../../api/accounting/pullPnlPdfs';

export async function syncQuickbooksReports(req, res) {
  const { userId, businessId } = req.body;

  try {
    await pullPnlPdfsForYear(userId, businessId);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Sync error:', err);
    return res.status(500).json({ error: 'Failed to sync reports' });
  }
}
