    await sendMessage('write notes.txt');
    await screen.findByRole('dialog', { name: /confirmation required/i });

    fireEvent.click(screen.getByRole('button', { name: /cancel response/i }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(confirmCall).toBe(1);
    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/cancel/'),
      expect.objectContaining({ method: 'POST' })
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /send message/i })).not.toBeDisabled();
    });
  });

  test('cancelling an in-flight request stops it, notifies the backend, and re-enables input', async () => {