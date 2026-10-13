const db = require('./database');

async function clearAllLeads() {
    await db.initDatabase();
    await db.run('PRAGMA foreign_keys = ON;');

    const beforeLeads = await db.get('SELECT COUNT(*) as c FROM leads');
    const beforeActs = await db.get('SELECT COUNT(*) as c FROM activities');
    const beforeRecipients = await db.get('SELECT COUNT(*) as c FROM campaign_recipients');
    const beforeQueue = await db.get('SELECT COUNT(*) as c FROM leadsquared_sync_queue');

    console.log(`Starting cleanup...`);
    console.log(`Current leads count: ${beforeLeads.c}`);
    console.log(`Current activities count: ${beforeActs.c}`);
    console.log(`Current campaign recipients count: ${beforeRecipients.c}`);
    console.log(`Current sync queue count: ${beforeQueue.c}`);

    // Clear dependent tables first
    await db.run('DELETE FROM activities');
    await db.run('DELETE FROM leadsquared_sync_queue');
    await db.run('DELETE FROM campaign_recipients');

    // Clear leads
    await db.run('DELETE FROM leads');

    // Reset autoincrement sequences
    try {
        await db.run("DELETE FROM sqlite_sequence WHERE name IN ('leads', 'activities', 'leadsquared_sync_queue', 'campaign_recipients')");
    } catch (e) {
        console.warn('Could not reset sqlite_sequence:', e.message);
    }

    // Reclaim disk space
    await db.run('VACUUM;');

    const afterLeads = await db.get('SELECT COUNT(*) as c FROM leads');
    const afterActs = await db.get('SELECT COUNT(*) as c FROM activities');
    const afterRecipients = await db.get('SELECT COUNT(*) as c FROM campaign_recipients');
    const afterQueue = await db.get('SELECT COUNT(*) as c FROM leadsquared_sync_queue');

    console.log(`\n========================================`);
    console.log(`CLEANUP COMPLETE:`);
    console.log(`Leads: ${beforeLeads.c} removed -> ${afterLeads.c} remaining`);
    console.log(`Activities: ${beforeActs.c} removed -> ${afterActs.c} remaining`);
    console.log(`Campaign Recipients: ${beforeRecipients.c} removed -> ${afterRecipients.c} remaining`);
    console.log(`Sync Queue: ${beforeQueue.c} removed -> ${afterQueue.c} remaining`);
    console.log(`========================================\n`);
}

clearAllLeads().catch(err => {
    console.error('Cleanup failed:', err);
    process.exit(1);
});
