// Codemod review fixture, round 3 (P1-2): a dim gray in a dark app is not on-solid (mainmenu EditorTopBar, PiAgentChatPanel).
export const Crumb = () => <span className="text-gray-700">/</span>;
export const Composer = () => <textarea className="h-[54px] w-full resize-none border border-[#333] bg-[#111] px-2 py-1.5 text-[11px] leading-snug text-gray-100 outline-none placeholder:text-gray-700" />;
