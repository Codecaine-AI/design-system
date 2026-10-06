// Codemod review fixture, round-3 close (R3-B3): mainmenu 637 and 647 (scene-engine projects/[projectId]/assets/page.tsx:62,75), read dark.
export const Chips = ({ selectedType, types }: { selectedType: string | null; types: string[] }) => (
  <nav className="mb-5 flex flex-wrap gap-2">
    <a
      href="/assets"
      className={`rounded-sm border px-2.5 py-1 text-xs no-underline ${
        selectedType
          ? 'border-[#333] bg-[#1d1d1d] text-gray-400 hover:bg-[#252525]'
          : 'border-[#2a6da3] bg-[#173247] text-[#cfe6ff]'
      }`}
    >
      All
    </a>
    {types.map((type) => (
      <a
        key={type}
        href={`/assets?type=${type}`}
        className={`rounded-sm border px-2.5 py-1 text-xs no-underline ${
          selectedType === type
            ? 'border-[#2a6da3] bg-[#173247] text-[#cfe6ff]'
            : 'border-[#333] bg-[#1d1d1d] text-gray-400 hover:bg-[#252525]'
        }`}
      >
        {type}
      </a>
    ))}
  </nav>
);
