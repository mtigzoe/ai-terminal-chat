
      await waitFor(() => {
        expect(axios.post).toHaveBeenCalledWith(
          expect.stringContaining('/chat'),
          expect.objectContaining({ allowed_paths: ['README.md'] }),
          expect.any(Object)
        );
      });
    });
  });

  // -----------------------------------------------------------------------
  // 7. Confirmation path: preserve selected-file read access when resuming
  describe('Confirmation path', () => {
    test('sends current allowed_paths when confirming an agent action', async () => {
      mockAxiosGet({ path: '/tmp/project' });
      defaultFetch();
      // This regression exercises manual confirmation, so keep the agent in ask mode.
      localStorage.setItem('ai-terminal-chat:agent-permission-mode', 'ask');
      localStorage.setItem('ai-terminal-chat:agent-permission-mode', 'ask');
      localStorage.setItem(
        'ai-terminal-chat:allowed-paths',
        JSON.stringify(['src/App.jsx'])
      );

      axios.post
        .mockResolvedValueOnce({
          data: {
            text: '',
            tool_activity: [{
              type: 'pending_confirmation',
              name: 'write_file',
              action_id: 'action-1',
              args: { path: 'src/App.jsx', contents: 'updated' },
              preview: { description: 'Write src/App.jsx' },
            }],
            request_id: 'r-confirm',
            pending_confirmation: {
              type: 'pending_confirmation',
              name: 'write_file',
              action_id: 'action-1',
              args: { path: 'src/App.jsx', contents: 'updated' },
              preview: { description: 'Write src/App.jsx' },
            },
          },
        })
        .mockResolvedValueOnce({
          data: {
            text: 'Done',
            tool_activity: [
              {
                type: 'tool_result',
                name: 'write_file',
                result: { ok: true },
              },
            ],
          },
        });

      render(<App />);
      fireEvent.change(screen.getByLabelText(/chat message/i), { target: { value: 'update the file' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));

      const allow = await screen.findByRole('button', { name: /^allow$/i });
      fireEvent.click(allow);

      await waitFor(() => {
        expect(axios.post).toHaveBeenLastCalledWith(
          expect.stringContaining('/confirm'),
          expect.objectContaining({
            action_id: 'action-1',
            confirmed: true,
            allowed_paths: ['src/App.jsx'],