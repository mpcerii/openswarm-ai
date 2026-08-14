// openSwarm builds never self-update: there is no openSwarm release channel,
// and following upstream openSwarm releases would silently replace this fork.
// Retarget the Installation service to openSwarm releases if one ever exists.
export async function upgrade() {}
