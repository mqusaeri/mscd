// Texts of the invitation banner in English and Indonesian (D2-01).
export const TEXT = {
  region: ['Invitations', 'Undangan'],
  invited: ['You were invited to {organisation}', 'Anda diundang ke {organisation}'],
  invitedBy: ['Invited by {name} on {date}.', 'Diundang oleh {name} pada {date}.'],
  invitedOn: ['Invited on {date}.', 'Diundang pada {date}.'],
  explain: ['Accept to work in this organisation as well; you switch between organisations in the sidebar.', 'Terima untuk juga bekerja di organisasi ini; Anda berpindah antar organisasi di bilah samping.'],
  accept: ['Accept', 'Terima'],
  decline: ['Decline', 'Tolak'],
  later: ['Later', 'Nanti'],
  accepted: ['You joined {organisation}. Switch to it in the organisation menu of the sidebar.', 'Anda bergabung dengan {organisation}. Beralih ke sana melalui menu organisasi di bilah samping.'],
  declined: ['Invitation to {organisation} declined', 'Undangan ke {organisation} ditolak'],
  declineTitle: ['Decline the invitation?', 'Tolak undangan?'],
  declineBody: ['You will not join {organisation}. An administrator of that organisation can invite you again.', 'Anda tidak akan bergabung dengan {organisation}. Administrator organisasi tersebut dapat mengundang Anda lagi.'],
  moreOne: ['1 more invitation waits', '1 undangan lain menunggu'],
  moreMany: ['{n} more invitations wait', '{n} undangan lain menunggu'],
} as const satisfies Record<string, readonly [string, string]>;
