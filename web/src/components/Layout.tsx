import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";

const NAV_ITEMS = [
  { to: "/", label: "Dashboard", icon: "▦", end: true },
  { to: "/new", label: "New Job", icon: "✦", end: false },
];

export const Layout = ({ children }: { children: ReactNode }): JSX.Element => {
  const [open, setOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  return (
    <div className="shell">
      <button
        type="button"
        className="menu-toggle"
        aria-label="Toggle navigation"
        onClick={() => setOpen((value) => !value)}
      >
        ☰
      </button>
      <div className={open ? "scrim show" : "scrim"} onClick={() => setOpen(false)} />

      <aside className={open ? "sidebar open" : "sidebar"}>
        <div className="brand">
          <div className="brand-mark">V</div>
          <span className="brand-name">Vector Studio</span>
        </div>

        <nav className="nav-group">
          <div className="nav-label">Platform</div>
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}
            >
              <span className="nav-icon" aria-hidden="true">
                {item.icon}
              </span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="user-row">
            <div className="avatar">P</div>
            <div>
              <div className="user-name">Psm Tech Team</div>
              <div className="user-role">Admin · Nxtwave</div>
            </div>
          </div>
        </div>
      </aside>

      <main className="main">{children}</main>
    </div>
  );
};
