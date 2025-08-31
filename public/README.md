# Stagify.ai Website

Virtual staging with one click - built for real estate agents and teams.

## Features

- **Free Virtual Staging**: Upload photos and get staged results in seconds
- **AI-Powered**: Advanced AI technology for realistic furniture placement
- **Multiple Styles**: Modern, Scandinavian, Luxury, and more
- **No Login Required**: Start staging immediately
- **Unlimited Regenerations**: Until you're satisfied

## Local Development

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Start development server**:
   ```bash
   npm run dev
   ```

3. **Open in browser**:
   Navigate to `http://localhost:3000`

## Deployment

### Render Deployment

1. **Connect your repository** to Render
2. **Create a new Static Site** service
3. **Configure settings**:
   - **Build Command**: `npm install`
   - **Publish Directory**: `.` (root of public folder)
   - **Environment**: Static Site

### Manual Deployment

1. **Build the project**:
   ```bash
   npm run build
   ```

2. **Deploy to your hosting provider**

## File Structure

```
public/
├── index.html          # Home page
├── why.html           # Why Us page
├── faq.html           # FAQ page
├── contact.html       # Contact page
├── styles/
│   └── styles.css     # Main stylesheet
├── scripts/
│   └── app.js         # Main JavaScript
├── media/
│   └── logo/          # Logo assets
└── package.json       # Dependencies and scripts
```

## Technologies Used

- **HTML5**: Semantic markup
- **CSS3**: Modern styling with animations
- **JavaScript**: Interactive features and animations
- **Node.js**: Development server

## Browser Support

- Chrome (latest)
- Firefox (latest)
- Safari (latest)
- Edge (latest)

## License

MIT License - see LICENSE file for details.
