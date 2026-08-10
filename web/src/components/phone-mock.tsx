/**
 * A faithful still of the app's home screen.
 *
 * Hand-built markup rather than a screenshot: it stays sharp at any density, weighs nothing, and
 * cannot quietly go out of date the way an exported PNG of a UI does.
 *
 * It mirrors `mobile/src/features/home.tsx` element for element — the accent balance card with the
 * network chip and the "confirming" line, the two quick actions, the recipients row, recent
 * activity, and the tab bar. A marketing mock that shows a screen the product does not have is a
 * promise the first launch breaks, so this tracks the real thing.
 */
export function PhoneMock() {
  return (
    <div className="phone reveal in" aria-hidden="true">
      <div className="phone-screen">
        {/* Greeting — no name, exactly as the app does it */}
        <div className="ph-header">
          <div>
            <div className="ph-brand">Prova</div>
            <div className="ph-sub">Send money home, privately</div>
          </div>
          <div className="ph-gear">
            <GearIcon />
          </div>
        </div>

        {/* Balance card */}
        <div className="ph-balance">
          <div className="ph-balance-top">
            <span className="ph-balance-label">Available balance</span>
            <span className="ph-net">testnet</span>
          </div>
          <div className="ph-balance-value">1,250.00</div>
          <div className="ph-pending">200.00 confirming — usually a few seconds</div>
          <div className="ph-actions">
            <div className="ph-action">
              <DownIcon />
              Add money
            </div>
            <div className="ph-action">
              <UpIcon />
              Send
            </div>
          </div>
        </div>

        {/* Recipients */}
        <div className="ph-section">
          <span>Recipients</span>
          <span className="ph-link">Manage</span>
        </div>
        <div className="ph-recipients">
          <div className="ph-recipient">
            <div className="ph-avatar ph-avatar-add">+</div>
            <span>Add</span>
          </div>
          <div className="ph-recipient">
            <div className="ph-avatar">AN</div>
            <span>Ananya</span>
          </div>
          <div className="ph-recipient">
            <div className="ph-avatar">RK</div>
            <span>Rahul</span>
          </div>
          <div className="ph-recipient">
            <div className="ph-avatar">MP</div>
            <span>Meera</span>
          </div>
        </div>

        {/* Recent activity */}
        <div className="ph-section">
          <span>Recent activity</span>
          <span className="ph-link">See all</span>
        </div>
        <div className="ph-rows">
          <div className="ph-row">
            <span className="ph-dot ph-dot-out" />
            <div className="ph-row-main">
              <span>Sent privately</span>
              <small>To Ananya · 2 hours ago</small>
            </div>
            <span className="ph-amt">−200.00</span>
          </div>
          <div className="ph-row">
            <span className="ph-dot ph-dot-in" />
            <div className="ph-row-main">
              <span>Added to balance</span>
              <small>Yesterday</small>
            </div>
            <span className="ph-amt ph-amt-in">+500.00</span>
          </div>
        </div>

        {/* Proof status — the thing that makes Prova different, so it stays visible */}
        <div className="phone-proof">
          <span className="pulse-dot" />
          Proof built on this device — no amount sent
        </div>

        {/* Tab bar */}
        <div className="ph-tabs">
          <span className="ph-tab ph-tab-on">
            <HomeIcon />
            Home
          </span>
          <span className="ph-tab">
            <ListIcon />
            Activity
          </span>
          <span className="ph-tab">
            <UserIcon />
            Profile
          </span>
        </div>
      </div>
    </div>
  );
}

/*
 * Inline SVG rather than an icon package: five glyphs at one size each, in a component that never
 * changes. Pulling in a library to draw them would ship a dependency to every visitor for this.
 */

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.9,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" {...stroke}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.63.68 1.1 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );
}

function DownIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" {...stroke}>
      <path d="M12 3v13M6 12l6 6 6-6M4 21h16" />
    </svg>
  );
}

function UpIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" {...stroke}>
      <path d="M7 17 17 7M8 7h9v9" />
    </svg>
  );
}

function HomeIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" {...stroke}>
      <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1Z" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" {...stroke}>
      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" {...stroke}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </svg>
  );
}
