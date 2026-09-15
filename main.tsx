import {createRoot} from 'react-dom/client';
import Canvas from './components/own-page';
import MarketplaceSetup from './components/marketplace-setup';
import './styles.css';

const setup = new URLSearchParams(window.location.search).get('setup') === '1';
createRoot(document.getElementById('root')!).render(setup ? <MarketplaceSetup/> : <Canvas/>);
