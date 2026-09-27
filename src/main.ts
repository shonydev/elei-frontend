import 'maplibre-gl/dist/maplibre-gl.css';
import './styles/global.css';

import './components/search-panel';
import './components/fab';
import './components/place-bar';
import './components/cafe-modal';
import './components/login-screen';
import './components/user-badge';

import type { EleiSearchPanel } from './components/search-panel';
import type { EleiCafeModal, CafeSubmitDetail } from './components/cafe-modal';
import type { EleiLoginScreen, AuthSubmitDetail } from './components/login-screen';
import type { EleiUserBadge } from './components/user-badge';

import { map, flyToPlace } from './map/map';
import { CafeMapView } from './map/cafe-map-view';
import { geocode } from './services/geocoding';
import { ApiError, UNAUTHORIZED_EVENT } from './services/api';
import { auth } from './services/auth';
import { session } from './services/session';
import { cafeStore } from './store/cafeStore';
import type { Cafe, LatLng, User } from './types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const searchPanel = $<EleiSearchPanel>('searchPanel');
const addCafeBtn = $<HTMLElement>('addCafeBtn');
const pin = $<HTMLElement>('centerPin');
const placeBar = $<HTMLElement>('placeBar');
const cafeModal = $<EleiCafeModal>('cafeModal');
const loginScreen = $<EleiLoginScreen>('loginScreen');
const userBadge = $<EleiUserBadge>('userBadge');

const cafeMapView = new CafeMapView(map);

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : 'Ocurrió un error inesperado.');

// ---------- Sesión y permisos ----------
// Solo el admin ve los controles de edición. Es únicamente UX: el backend valida el rol en cada petición.
let currentUser: User | null = null;
const canEdit = () => currentUser?.role === 'admin';

function showLogin(message = '') {
  currentUser = null;
  cafeMapView.clear();
  resetPlacing();
  cafeModal.hidden = true;
  pendingLocation = null;
  userBadge.hidden = true;
  addCafeBtn.hidden = true;
  loginScreen.reset(message);
  loginScreen.hidden = false;
}

async function enterApp(user: User) {
  currentUser = user;
  loginScreen.hidden = true;
  userBadge.user = user;
  userBadge.hidden = false;
  addCafeBtn.hidden = !canEdit();
  await loadCafes();
}

loginScreen.addEventListener('elei-auth-submit', async (e) => {
  const { mode, email, password } = (e as CustomEvent<AuthSubmitDetail>).detail;
  loginScreen.setBusy(true);
  loginScreen.setError('');
  try {
    const user = mode === 'login' ? await auth.login(email, password) : await auth.register(email, password);
    await enterApp(user);
  } catch (error) {
    loginScreen.setError(errorMessage(error));
  } finally {
    loginScreen.setBusy(false);
  }
});

userBadge.addEventListener('elei-logout', () => {
  auth.logout();
  showLogin();
});

// El servidor rechazó el token (expiró o el usuario fue eliminado).
window.addEventListener(UNAUTHORIZED_EVENT, () => showLogin('Tu sesión expiró. Vuelve a iniciar sesión.'));

async function boot() {
  const stored = session.getUser();
  if (!session.getToken() || !stored) return showLogin();
  try {
    await enterApp(await auth.me()); // refresca el rol desde el servidor
  } catch (error) {
    // Sin conexión: se entra con el usuario guardado. Cualquier otro fallo (401...) ya limpió la sesión.
    if (error instanceof ApiError && error.status === 0) await enterApp(stored);
    else showLogin();
  }
}

// ---------- Búsqueda de ciudad ----------
async function loadCity(query: string) {
  searchPanel.setStatus(`Buscando ${query}…`);
  try {
    const place = await geocode(query);
    flyToPlace(place);
    searchPanel.setStatus(`Listo — ${query}`);
  } catch {
    searchPanel.setStatus('No pude encontrar ese lugar.');
  }
}

searchPanel.addEventListener('elei-search', (e) => {
  loadCity((e as CustomEvent<{ query: string }>).detail.query);
});

map.on('load', () => searchPanel.setStatus('Listo'));

// ---------- Modo "ubicar" (pin fijo al centro, estilo Uber) ----------
// Es un flujo de UI (botón → pin → confirmar → modal), no lógica del mapa en sí,
// por eso queda acá y no en map/map.ts. Solo el admin puede iniciarlo.
let placing = false;
let pendingLocation: LatLng | null = null;
let saving = false;

function startPlacing() {
  if (!canEdit()) return;
  placing = true;
  pin.hidden = false;
  placeBar.hidden = false;
  addCafeBtn.hidden = true;
}
function stopPlacing() {
  resetPlacing();
  addCafeBtn.hidden = !canEdit();
}
function resetPlacing() {
  placing = false;
  pin.hidden = true;
  placeBar.hidden = true;
}

map.on('movestart', () => placing && pin.classList.add('lifted'));
map.on('moveend', () => pin.classList.remove('lifted'));

addCafeBtn.addEventListener('elei-fab-click', startPlacing);
placeBar.addEventListener('elei-place-cancel', stopPlacing);
placeBar.addEventListener('elei-place-confirm', () => {
  map.stop();
  const c = map.getCenter(); // el pin apunta exactamente al centro del mapa
  pendingLocation = { lng: c.lng, lat: c.lat };
  stopPlacing();
  cafeModal.open();
  cafeModal.hidden = false;
});

// ---------- Formulario / alta de cafetería ----------
cafeModal.addEventListener('elei-cafe-cancel', () => {
  cafeModal.hidden = true;
  pendingLocation = null;
});

cafeModal.addEventListener('elei-cafe-submit', async (e) => {
  const { name, photo } = (e as CustomEvent<CafeSubmitDetail>).detail;
  if (!pendingLocation || saving) return; // `saving` evita crear duplicados con doble toque
  saving = true;
  try {
    cafeMapView.showCafe(await cafeStore.add({ name, photo, ...pendingLocation }), canEdit(), deleteCafe);
    cafeModal.hidden = true;
    pendingLocation = null;
  } catch (error) {
    alert(`No se pudo guardar: ${errorMessage(error)}`);
  } finally {
    saving = false;
  }
});

// ---------- Persistencia y coordinación de cafeterías ----------
// Devuelve true cuando el marcador debe desaparecer (borrado correcto o ya inexistente).
async function deleteCafe(id: string): Promise<boolean> {
  try {
    await cafeStore.remove(id);
    return true;
  } catch (error) {
    // 404 = ya no existe en el servidor: igual lo quitamos del mapa.
    if (error instanceof ApiError && error.status === 404) return true;
    alert(`No se pudo eliminar: ${errorMessage(error)}`);
    return false;
  }
}

async function loadCafes() {
  cafeMapView.clear();
  try {
    (await cafeStore.list()).forEach((cafe) => cafeMapView.showCafe(cafe, canEdit(), deleteCafe));
  } catch (error) {
    // Si fue un 401, showLogin() ya se encargó; para otros errores avisamos en el panel.
    if (!(error instanceof ApiError && error.status === 401)) {
      searchPanel.setStatus(`No se pudieron cargar las cafeterías: ${errorMessage(error)}`);
    }
  }
}

// ---------- Arranque ----------
void boot();
