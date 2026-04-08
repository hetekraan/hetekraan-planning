(function () {
  function showDeleteConfirm() {
    const firstButton = document.getElementById('btnDeleteFirst');
    const confirmRow = document.getElementById('deleteConfirmRow');
    if (firstButton) firstButton.style.display = 'none';
    if (confirmRow) confirmRow.style.display = 'flex';
  }

  function hideDeleteConfirm() {
    const firstButton = document.getElementById('btnDeleteFirst');
    const confirmRow = document.getElementById('deleteConfirmRow');
    if (firstButton) firstButton.style.display = '';
    if (confirmRow) confirmRow.style.display = 'none';
  }

  function openModal() {
    const dateInput = document.getElementById('dateInput');
    const modalDate = document.getElementById('mDate');
    const modalOverlay = document.getElementById('modalOverlay');
    const today = dateInput?.value || new Date().toISOString().split('T')[0];
    if (modalDate) modalDate.value = today;
    if (modalOverlay) modalOverlay.classList.add('visible');
  }

  function closeModal() {
    const modalOverlay = document.getElementById('modalOverlay');
    if (modalOverlay) modalOverlay.classList.remove('visible');
  }

  window.HKPlannerModalUi = {
    showDeleteConfirm,
    hideDeleteConfirm,
    openModal,
    closeModal,
  };
})();
