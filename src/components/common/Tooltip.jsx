import { cloneElement, useId } from 'react';
import { NAV_TOOLTIP_STYLE } from '../../layout/navRailTooltipStyle.js';
import './Tooltip.css';

// Shared dark tooltip; the child keeps its accessible name, without a native title.
export default function Tooltip({ content, children, align = 'end' }) {
  const id = useId();
  return <span className="bizzi-tooltip-anchor" data-align={align}>
    {cloneElement(children, { 'aria-describedby': [children.props['aria-describedby'], id].filter(Boolean).join(' ') })}
    <span id={id} role="tooltip" className="bizzi-tooltip-content" style={NAV_TOOLTIP_STYLE}>{content}</span>
  </span>;
}
