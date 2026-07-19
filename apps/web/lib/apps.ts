export interface AppLink { name: string; url: string; desc: string; }
export const APP_LINKS: AppLink[] = [
  { name: "Dashboard", url: "https://dashboard.frynetworks.com", desc: "Devices, rewards, manual claims" },
  { name: "Explorer", url: "https://explorer.frynetworks.com", desc: "Network explorer" },
  { name: "Vote", url: "https://vote.frynetworks.com", desc: "DAO governance" },
  { name: "BYOD", url: "https://byod.frynetworks.com", desc: "Bring-your-own-device licensing" },
  { name: "fry.farm", url: "https://fry.farm", desc: "Farming platform" },
  { name: "fry.market", url: "https://fry.market", desc: "Marketplace" },
  { name: "Docs", url: "https://docs.frynetworks.com", desc: "Whitepaper & litepaper" },
  { name: "Help Desk", url: "https://tickets.frynetworks.com", desc: "Support tickets" },
];
