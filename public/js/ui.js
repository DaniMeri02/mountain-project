export function updatePanel(props) {
  const panel = document.getElementById('panel');
  
  const typeCapitalized = props.type.charAt(0).toUpperCase() + props.type.slice(1);
  const descHTML = props.description ? `<p>${props.description}</p>` : `<p><em>No description available.</em></p>`;
  const siteHTML = props.website ? `<p><a href="${props.website}" target="_blank">Visit website</a></p>` : '';

  panel.innerHTML = `
    <h2>${props.name}</h2>
    <div style="margin-bottom: 20px;">
      <span style="background-color: #2c3e50; color: white; padding: 4px 8px; border-radius: 4px; font-size: 0.8rem;">
        ${typeCapitalized}
      </span>
      <span style="background-color: #7f8c8d; color: white; padding: 4px 8px; border-radius: 4px; font-size: 0.8rem; margin-left: 5px;">
        ${props.elevation}m asl
      </span>
    </div>
    ${descHTML}
    ${siteHTML}

    <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
    <div id="ai-container" style="background: #f8f9fa; padding: 15px; border-radius: 8px; border: 1px solid #e9ecef;">
      <h3 style="margin-top: 0; font-size: 1.1rem; color: #333;">🤖 AI Guide</h3>
      <p style="font-size: 0.9rem; color: #666; margin-bottom: 10px;">Generate a complete description with reviews, history, and real-time web search details.</p>
      <button id="generate-ai-btn" class="ai-magic-btn">
        ✨ Generate AI Guide
      </button>
      <div id="ai-result" style="margin-top: 15px; font-size: 0.95rem; line-height: 1.5; color: #444; display: none;"></div>
    </div>
  `;

  // Attach event listener for the AI generation button
  const btn = document.getElementById('generate-ai-btn');
  const resultDiv = document.getElementById('ai-result');

  if (btn && resultDiv) {
    btn.addEventListener('click', async () => {
      // Show loading state
      btn.style.display = 'none';
      resultDiv.style.display = 'block';
      resultDiv.innerHTML = '<div style="text-align: center; color: #666;"><em>Searching the web and generating... ⏳</em></div>';

      try {
        const response = await fetch('/api/ai/research', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            name: props.name,
            type: props.type,
            elevation: props.elevation
          })
        });

        if (!response.ok) {
          throw new Error('Error during AI generation');
        }

        const data = await response.json();
        
        // Format newline characters as HTML breaks line
        const formattedText = data.text.replace(/\ng/, '<br/>');
        resultDiv.innerHTML = formattedText;
      } catch (error) {
        console.error(error);
        resultDiv.innerHTML = '<div style="color: #e74c3c; font-weight: bold;">Error: Unable to generate the guide right now.</div>';
        btn.style.display = 'block';
        btn.innerText = 'Try Again';
      }
    });
  }
}

