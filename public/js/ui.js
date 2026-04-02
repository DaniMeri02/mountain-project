export function updatePanel(props) {
  const panel = document.getElementById('panel');
  
  const typeCapitalized = props.type.charAt(0).toUpperCase() + props.type.slice(1);
  const descHTML = props.description ? `<p>${props.description}</p>` : `<p><em>Nessuna descrizione disponibile.</em></p>`;
  const siteHTML = props.website ? `<p><a href="${props.website}" target="_blank">Visita il sito web</a></p>` : '';
  
  panel.innerHTML = `
    <h2>${props.name}</h2>
    <div style="margin-bottom: 20px;">
      <span style="background-color: #2c3e50; color: white; padding: 4px 8px; border-radius: 4px; font-size: 0.8rem;">
        ${typeCapitalized}
      </span>
      <span style="background-color: #7f8c8d; color: white; padding: 4px 8px; border-radius: 4px; font-size: 0.8rem; margin-left: 5px;">
        ${props.elevation}m slm
      </span>
    </div>
    ${descHTML}
    ${siteHTML}
    
    <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
    <p style="color: #e67e22; font-style: italic;">
      🤖 <strong>AI Assistant:</strong> "In futuro, quando cliccherai qui, leggerò recensioni su ${props.name} per dirti com'è lo stato del sentiero oggi!"
    </p>
  `;
}
